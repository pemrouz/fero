//! L2 public surface: fero(name, opts) → { data, methods, cluster, destroy } — the whole library in one call.
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

import { $, view as VIEWSYM } from '../../data/index.ts'
import { transport, type Mesh, type TransportOpts } from '../transport/index.ts'
import { Log, originKey } from '../log/log.ts'
import { applyRecord } from '../log/index.ts'
import { partitionOf, type ChangeRecord } from '../transport/message.ts'
import { ViewManager } from './membership.ts'
import { makeFold } from './fold.ts'
import { makeDispatch } from './dispatch.ts'

export { value } from '../../data/index.ts'
export { fileStorage } from './storage.ts'

export type Method = (arg: any, context: Context) => any

//! Cluster surface: peers + identity + ownership/replica queries + the committed view (epoch/members/writable).
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

//! Context: the second arg every method receives — data/cluster/methods/log/name + the calling peer (routed RPC).
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

//! Fero: the returned instance — the three reactive surfaces + teardown.
export type Fero = {
  data: any
  methods: Record<string, (arg?: any) => any>
  cluster: Cluster
  destroy: () => void
}

//! Storage: the durable-log seam (plan §4) — load() replays at boot, append() persists each accepted record.
// Durable-log seam (plan §4). `load` returns the persisted records at boot (they
// replay through the same accept path as inbound replication); `append` persists
// each accepted record. A built-in file adapter lives in ./storage.ts; bring your
// own (Redis, S3, a DB WAL) by implementing these two.
export type Storage = {
  load: () => ChangeRecord[] | Promise<ChangeRecord[]>
  append: (record: ChangeRecord) => void
}

//! FeroOpts: method functions + resource config + transport opts (minus name/onRecord) + optional storage.
export type FeroOpts = Record<string, unknown> & Partial<Omit<TransportOpts, 'name' | 'onRecord'>> & { storage?: Storage }

//! norm: coerce a record key (array path or bare scalar sugar) to a path array.
// A change record's `key` may arrive as an array path (`['user42','active']`)
// or a bare scalar (`'user42'`, sugar). Normalize to a path.
const norm = (k: unknown): (string | number)[] =>
  Array.isArray(k) ? k : k == null ? [] : [k as string | number]

//! setPath/delPath: walk the proxy tree and assign/delete the leaf, so the set/delete trap emits one record.
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

//! fero(name, opts): compose L0 mesh + L1 records into the three surfaces; await = ready (plan §1).
export async function fero(name: string, opts: FeroOpts = {}): Promise<Fero> {
  // Build phases (skim the ── banners): 0 config · 1 replication core · 2 restore+mesh
  // · 3 holding+membership · 4 write path (+orphan shed) · 5 surfaces.

  //! ── 0 · config: methods/config split + replication factor ──
  // ── 0 · config: methods/config split + replication factor ──
  // Recognition rule (plan §1): function values are methods, everything else is
  // transport/resource config. By value type, not key name.
  const methods: Record<string, Method> = {}
  const config: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(opts)) {
    if (typeof v === 'function') methods[k] = v as Method
    else config[k] = v
  }

  //! R = replication factor (Milestone P): finite ⇒ scoped per-partition holding; default ∞ ⇒ full replication.
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
  //! antiEntropyMs: periodic anti-entropy interval driving scoped acquisition + drift healing (resync below).
  // Periodic anti-entropy interval (ms) — drives scoped acquisition + drift healing
  // (see resync below). Extracted so it isn't passed to the transport; only armed in
  // scoped mode.
  const antiEntropyMs = typeof config.antiEntropy === 'number' ? (config.antiEntropy as number) : 1000
  delete (config as any).antiEntropy

  //! ── 1 · replication core: state (proxy = truth, log = history) + provenance + dedup + LWW ──
  // ── 1 · replication core: state (proxy = truth, log = history) + provenance + dedup + LWW ──
  // State: the proxy is the source of truth; the log records history.
  const log = new Log({ scoped })
  const data = $({})
  const res = (data as any)[VIEWSYM].res

  // Provenance + dedup + last-writer-wins.
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
  let clock = 0 //! this node's Lamport clock; local writes stamp ++clock so a local write always wins LWW
  //! seen: per-seenKey dedup high-water marks; doubles as the anti-entropy digest a node ships.
  // Dedup high-water, keyed by seenKey(origin, partition) below: per-origin under
  // full replication (compact digest), per-(origin,partition) under scoped holding
  // (Milestone P — so each partition's stream is independently complete). Doubles
  // as the anti-entropy digest a node sends (Object.fromEntries(seen)).
  const seen = new Map<string, number>()
  //! versions: keyPath → current LWW winner stamp, MUTATED in place on re-write (zero steady-state alloc).
  // keyPath → current LWW winner. The {seq,origin} stamp is MUTATED in place on
  // re-write (not reallocated) so the steady-state write path allocates nothing
  // here — version churn was the dominant cost when this was a fresh object per
  // write (see index.perf.ts).
  const versions = new Map<string, { epoch: number; seq: number; origin: string }>()
  //! pending: write-gate buffer (V1e) — writes held while quorum-less, flushed on quorum return; bounded drop-oldest.
  // Write-gate buffer (Milestone V1e): writes attempted while we can't reach a
  // quorum of the view are held here (NOT committed/broadcast) and flushed when
  // quorum returns — so a partition's minority side stays read-only instead of
  // diverging. Bounded (drop-oldest) so a long partition can't grow it without limit.
  const pending: ChangeRecord[] = []
  const MAX_PENDING = 10_000

  //! versionKey: the key a record contends on for LWW — `at` folded into the path → field-level LWW.
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

  //! seenKey: provenance key for dedup/catch-up — origin alone (full) or (origin,partition) (scoped).
  // The provenance key a record dedups / catches-up under (see `seen` above).
  // Full replication ⇒ origin alone; scoped holding ⇒ (origin,partition). Mirrors
  // the log's index granularity (constructed with the same `scoped` flag), so the
  // digest a node sends and the records a peer ships back agree on the key.
  const seenKey = scoped
    ? (origin: string, p: string): string => originKey(origin, p)
    : (origin: string, _p: string): string => origin

  //! applying: guard set while applying an inbound record, so its sink re-emission isn't re-logged/re-broadcast.
  // Inbound records carry their origin's provenance. (1) Drop duplicates by
  // per-origin high-water. (2) Log every accepted record (the full per-origin
  // history catch-up forwards from). (3) Apply only LWW winners to the proxy —
  // losers stay in the log but don't mutate state. The apply re-emits through
  // the write-capture sink; the `applying` guard stops that re-emission from
  // being re-logged or re-broadcast.
  let applying = false
  //! committingForward: guard so an applied forwarded write commits as-is, never re-evaluating ownership.
  // Set while a FORWARDED write is being applied locally (see commitForwarded): the
  // sink commits it as-is instead of re-evaluating ownership, so it never bounces.
  let committingForward = false

  //! applyInbound: dedup → Lamport-merge → log → LWW-resolve → apply winner; shared by replication + restore replay.
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
      //! LWW resolve, lexicographic (epoch, seq, origin): epoch fences stale views, seq then origin decide; loser stays logged.
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

  //! ── 2 · durable restore + transport mesh ──
  // ── 2 · durable restore + transport mesh ──
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

  //! mesh: the L0 transport, wired with all the inbound hooks (record/digest/RPC/subscribe/write/view).
  const mesh: Mesh = transport({
    name,
    ...(config as object),
    // NB: these hooks call closures defined BELOW (holds / resync / shedConfirmed /
    // commitForwarded / viewMgr / dispatch). Safe forward refs: a hook only fires
    // post-construction (once a peer connects), by which point all are bound.
    //! onRecord: held-gate then accept — scoped nodes drop records for partitions they don't replicate.
    // Scoped holding (Milestone P): materialize ONLY partitions we replicate. A
    // server with finite R drops inbound records for partitions it doesn't hold
    // (scoped delivery shouldn't send them, but catch-up over-ship or a transitional
    // ring could). Storage replay calls applyInbound DIRECTLY (it restores our own
    // held partitions), so the held-gate lives here, not in applyInbound.
    onRecord: (record: ChangeRecord) => {
      if (scoped && !holds(partitionOf(record))) return
      applyInbound(record)
    },
    //! onConnect: on handshake, a server sends its digest (reply:true) so catch-up heals both directions.
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
    //! onDigest: ship the records the peer lacks (scoped: only partitions it replicates), confirm-shed, reply once.
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
        recs = recs.filter((r) => mesh.holds(partitionOf(r), payload.me, R))
      mesh.catchupTo(address, recs)
      // Confirmed shedding (P4): the sender's marks tell us whether it (an R-set
      // member) is caught up on a partition we hold but no longer replicate — if so,
      // shed our orphan copy.
      if (scoped && payload?.me) shedConfirmed(payload.v ?? {}, payload.me)
      if (me !== undefined && payload?.reply) mesh.digestTo(address, { v: Object.fromEntries(seen), reply: false, me })
    },
    //! onCall: inbound RPC — run the named method with the caller as context.peer, ship the return value back.
    // Inbound RPC: a client called one of our methods. Run it here with the
    // caller as context.peer; the transport ships the return value back. (The
    // dispatch surface is built after the method table below — these hooks fire
    // only once a client connects, post-construction, so `dispatch` is bound.)
    onCall: (method: string, arg: unknown, address: string) => dispatch.serveCall(method, arg, address),
    //! onSubscribe: inbound subscription — stream a returned ViewProxy's deltas to the client (else one value).
    // Inbound subscription: run the method, and if it returns a ViewProxy stream
    // its deltas (initial snapshot + changes) to the client; else ship one value.
    onSubscribe: (subId: number, method: string, arg: unknown, address: string) => dispatch.serveSubscribe(subId, method, arg, address),
    onUnsubscribe: (subId: number, address: string) => dispatch.serveUnsubscribe(subId, address),
    //! onPeerGone: reap a dropped peer's served subscriptions so a gone client doesn't leak sinks/openFolds.
    // A peer dropped (socket close / destroy) without an UNSUBSCRIBE — reap its served subscriptions
    // so a gone client/coordinator doesn't leak its sinks / openFolds (subscription hygiene).
    onPeerGone: (address: string) => dispatch.reapPeer(address),
    //! onWrite: a forwarded write for a partition we own — commit it locally; we are its single sequencer.
    // Inbound write-request: a peer forwarded a write for a partition we own.
    // Apply it as a LOCAL write so our sink commits it (stamps origin=us, logs,
    // replicates) — we are the single sequencer for the partition.
    onWrite: (record: ChangeRecord) => commitForwarded(record),
    //! onView*: membership view-change frames (Milestone V) routed to the ViewManager state machine.
    // Membership view-change frames (Milestone V) → the view-change state machine.
    onViewPrepare: (value: unknown) => viewMgr?.onPrepare(value),
    onViewAck: (value: unknown) => viewMgr?.onAck(value),
    onViewCommit: (value: unknown) => viewMgr?.onCommit(value),
    onJoinRequest: (value: unknown) => viewMgr?.onJoinRequest(),
  })

  const uuid = mesh.uuid
  const me = mesh.me

  const viewSize = (): number => mesh.viewMembers().length

  //! ── 3 · holding + membership + anti-entropy ──
  // ── 3 · holding + membership + anti-entropy ──
  // Does this node hold (replicate) a partition's records? Full replication ⇒
  // always (every server holds everything). Scoped (finite R) ⇒ only if we're in
  // the partition's R-set on the committed-view ring. A read-only client (no `me`)
  // holds nothing. The R≥members short-circuit avoids an owners() ring scan when R
  // covers everyone (scoped degenerates to full replication) — this runs on every
  // inbound record + foreign write, so the scan would be a hot-path blowup.
  //! holds(key): does this node replicate the partition? full ⇒ always; scoped ⇒ in its R-set on the ring (memoized).
  // The ring is constant between view commits, so memoize the owners() scan per key
  // (cleared on commit). Keeps holds() — on the inbound, write, AND facade-read paths
  // — O(1) in steady state instead of an O(R) ring walk per access.
  const heldCache = new Map<string, boolean>()
  const holds = (key: string): boolean => {
    if (me === undefined) return false
    if (!scoped || R >= viewSize()) return true
    let h = heldCache.get(key)
    if (h === undefined) heldCache.set(key, (h = mesh.holds(key, me, R)))
    return h
  }

  //! resync (scoped): digest every view member to acquire rebalanced partitions + heal drift (reciprocal heals both ways).
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

  //! aggregate registries (Q2c): rebinds re-scope live partials on a ring change; reconciles fix fold holder sets.
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
  type Rescope = () => void // re-scope a live owner-scoped partial over the new ring (walked on commit)
  type Reconcile = () => void // add/drop/retry a live fold's remote-holder subscriptions (commit + AE tick)
  const aggregateRebinds = new Set<Rescope>()
  const aggregateReconciles = new Set<Reconcile>()

  //! viewMgr (servers only): the view-change state machine — committed {epoch,members}; onCommit rebalances + rebinds.
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

  //! aeTimer (scoped): periodic resync + fold-reconcile — the backstop for acquisition/drift a commit-triggered run can race.
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

  //! ── 4 · write path: capture sink → forward-to-owner | commit-local ──
  // ── 4 · write path: capture sink → forward-to-owner | commit-local ──
  // Write-capture: a local assignment on the proxy is stamped with our provenance, recorded as the
  // current LWW winner for its key (the proxy already materialized it — the newest write we know of),
  // logged, and broadcast. `connect(obj, fn)` pins the sink to `obj`; we retain that host (via
  // destroy's closure) so the sink stays alive (data holds it only by WeakRef).
  //
  // FOUR BRANCHES, in order (the numbered leads in the body mark each):
  //   1) prime        — swallow the empty attach-snapshot of the fresh proxy.
  //   2) applying-skip — an inbound re-emission (the `applying` guard); already logged/applied in onRecord.
  //   3) F1 forward    — owner-routed writes: the partition OWNER is the single sequencer for its keys.
  //      If we don't own this partition and the owner is a connected peer, FORWARD the raw write; the
  //      owner commits it under its own provenance and replicates the canonical record back. The
  //      optimistic local value is already applied (the set trap ran before this sink), so we hand off
  //      and return. Clients (no `me`) and an unreachable owner fall through to (4) so a write is never
  //      dropped. A FORWARDED write (committingForward) SKIPS this branch — committed as-is in (4)
  //      without re-checking ownership: re-checking would re-forward whenever ring views transiently
  //      disagree during mesh formation, ping-ponging the write until membership converges; honoring the
  //      forwarder's decision ends it in one hop (a brief disagreement at worst commits at a not-yet-true
  //      owner, which still replicates and converges by LWW, as pre-F1). The dedup/LWW core's in-order
  //      invariant holds per (origin,partition) — each partition's single owner is one in-order source.
  //   4) commit-local — stamp/log/replicate under our provenance (owned partitions + never-drop fallback).
  // NB: a plain `data.x = y` commits straight through this sink — it does NOT dispatch through
  // methods.update/insert/remove, so a user-overridden `update` (auth/validation) intercepts only
  // methods.update(...) calls, not assignments. Deliberate (routing assignments through the method
  // risks the re-entrancy the `applying` guard prevents, plan §7) — ../IDEAS.md "Assignment ↔
  // methods.update parity".
  let primed = false
  const writeHost = data.connect({}, (change: ChangeRecord) => {
    //! 1) prime: swallow the empty attach-snapshot.
    // 1) prime: swallow the empty attach-snapshot.
    if (!primed) {
      primed = true
      return
    }

    //! 2) applying-skip: an inbound re-emission — already handled in onRecord.
    // 2) applying-skip: an inbound re-emission — already handled in onRecord.
    if (applying) return

    //! 3) F1 forward: not owner + owner reachable ⇒ hand off (a forwarded write skips this).
    // 3) F1 forward: not owner + owner reachable ⇒ hand off (a forwarded write skips this).
    if (!committingForward) {
      const p = partitionOf(change)
      const owner = me !== undefined ? mesh.owner(p) : undefined
      if (owner !== undefined && owner !== me && mesh.forward(owner, change)) {
        // P2: forwarded a write for a partition we DON'T replicate — drop the optimistic value (the
        // owner replicates to the R-set, not us; reading this key is a Q1 remote read). Full
        // replication keeps it: the canonical record returns and reconciles.
        if (scoped && !holds(p)) discardOptimistic(p)
        return
      }
    }

    //! 4) commit-local: stamp/log/replicate under our provenance.
    // 4) commit-local: stamp/log/replicate under our provenance.
    commitLocal(change)
  })

  //! ── orphan shedding (P4, scoped): keep a no-longer-replicated partition until an R-set member is caught up, then drop ──
  // ── orphan shedding (P4, scoped): keep a no-longer-replicated partition until a
  //    current R-set member is confirmed caught up, then drop it (never < R replicas) ──
  //! orphans / shedReady: partitions we hold but no longer replicate, + the R-set members confirmed caught up on each.
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

  //! discardOptimistic: drop a forwarded-but-unheld partition we optimistically applied (guarded — no sink echo).
  // Silently remove a foreign partition we optimistically applied but don't hold
  // (after forwarding its write to the owner). Guarded by `applying` so the removal
  // doesn't re-enter the sink — no echo, no spurious forwarded 'remove'.
  const discardOptimistic = (partition: string) => {
    applying = true
    try {
      applyRecord(res, { type: 'remove', key: [partition] })
    } finally {
      applying = false
    }
  }

  //! shed: fully drop an orphan from proxy/log/seen/versions — complete handoff, only after R-set confirmed caught up.
  // Fully shed an orphan partition (Milestone P4): remove it from the proxy, the
  // log (segment + provenance index), the dedup high-water, and the LWW version map
  // — a complete handoff off this node. Called ONLY once a current R-set member is
  // confirmed caught up (shedConfirmed), so the partition is never less than
  // R-replicated. After this we no longer claim the partition in our digest.
  const shed = (partition: string) => {
    discardOptimistic(partition) // proxy (guarded — no re-emit / spurious forwarded remove)
    log.drop(partition)
    const suffix = '\x00' + partition
    for (const k of seen.keys()) if (k.endsWith(suffix)) seen.delete(k)
    for (const k of versions.keys()) if (k === partition || k.startsWith(partition + '\x00')) versions.delete(k)
    orphans.delete(partition)
    shedReady.delete(partition)
  }

  //! markOrphans: on a ring rebalance, flag held-but-no-longer-replicated partitions as orphans-to-shed.
  // Note partitions we hold but no longer replicate as orphans-to-shed (scan on view
  // commit, when the ring rebalances). A write committed locally at a non-replica
  // adds itself directly (commitLocal).
  const markOrphans = () => {
    if (!scoped || me === undefined) return
    for (const p of log.partitions()) if (!holds(p) && !orphans.has(p)) orphans.add(p)
  }

  //! shedConfirmed: mark an R-set peer caught up on each orphan from its digest; shed only when EVERY member is (never < R).
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

  //! commitLocal: stamp under our provenance, record as LWW winner, log, replicate — owned writes + never-drop fallback.
  // Commit a record under OUR provenance: stamp (origin=us, Lamport seq), record
  // it as the LWW winner for its key, log it, and replicate. Used for partitions
  // we own and as the never-drop fallback when an owner is unreachable.
  function commitLocal(change: ChangeRecord) {
    //! write-gate chokepoint (V1e): no quorum ⇒ buffer instead of commit, so a minority can't diverge.
    // Write-gate chokepoint (V1e): without a reachable quorum we are read-only —
    // buffer the write (don't stamp/log/broadcast) so a minority can't diverge.
    // This SUPERSEDES F1's never-drop local commit for a quorum-less node. Both
    // local writes and forwarded writes (commitForwarded) funnel through here.
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
    //! replicate: scoped R<members ⇒ send to the R-set only (orphan-mark if we're not in it); else broadcast to all.
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

  //! commitForwarded: apply a forwarded write so the sink commits it as ours; committingForward stops a re-forward.
  // A peer forwarded a write for a partition we own. Apply it to our proxy as a
  // local write (NOT guarded by `applying`) so the write-capture sink above runs
  // and commits it under our provenance — turning the forwarder's optimistic
  // write into our authoritative, sequenced one. `committingForward` tells the
  // sink to commit it as-is rather than re-evaluate ownership (no re-forward → no
  // ping-pong while ring views are still settling).
  const commitForwarded = (record: ChangeRecord) => {
    committingForward = true
    try {
      applyRecord(res, record)
    } finally {
      committingForward = false
    }
  }

  //! flushPending: quorum returned — re-commit the buffered writes in order (re-buffers if the gate closed again).
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

  //! distributed aggregates (Q2/Q3): the fold ENGINE lives in ./fold.ts (makeFold), built below once invoke+clientSubs exist.
  // Distributed aggregates (Milestone Q2/Q3): the fold ENGINE — owner-scoped partial
  // construction, the live re-scoping partial, and the querying-side one-shot + live gather
  // — lives in [./fold.ts] (makeFold), built below once `invoke` + clientSubs exist (the
  // engine's only injected deps beyond the raw proxy/mesh/state).

  //! ── 5 · surfaces: cluster + methods + dispatch ──
  //! cluster: the public cluster surface — peers, identity, owner/replica queries, live view (epoch/members/writable).
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

  //! defaults: read/aggregate/update/insert/remove (plan §6.3), each overridable by a same-named opts function.
  // Default methods (plan §6.3), overridable by same-named opts functions. Each
  // assigns to context.data → the write-capture sink replicates the result. A method
  // assigning to data is a trusted local commit; it does NOT re-invoke the method
  // (plan §5 recursion-safety) — the sink replicates, it doesn't dispatch.
  const defaults: Record<string, Method> = {
    //! read() → whole data; read(key) → that key's child view (Q1 keyed read, server side of a remote read).
    // read() → whole data; read(key) → just that key's child view (Q1 keyed read —
    // the server side of an owner-routed remote read). On a holder, c.data[key] is
    // the live local child; snapshot for the RPC reply, streamed for a subscription.
    read: (arg, c) => (typeof arg === 'string' ? c.data[arg] : c.data),
    //! aggregate(spec) → this node's owner-scoped PARTIAL; the querying node fans out + folds the disjoint cover (Q2).
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

  //! invoke: run a named method on this server with context (+ peer when routed); the in-process dispatcher.
  // Run a method here (on this server). `peer`, when set, is the calling client
  // — handlers read it as context.peer for auth. A method returning a ViewProxy
  // (e.g. the default `read`) is reduced to a snapshot for the RPC reply path;
  // the live-subscription path (returning the proxy itself) is deferred (E).
  const invoke = (method: string, arg: unknown, peer?: string): unknown => {
    const fn = allMethods[method]
    if (!fn) throw new Error(`fero: unknown method "${method}"`)
    return fn(arg, peer ? { ...context, peer } : context)
  }

  const clientSubs = new Set<() => void>()

  //! fold: build the distributed-aggregate engine (./fold.ts) now that invoke + the registries + clientSubs exist.
  // The distributed-aggregate fold engine (Milestone Q2/Q3) — owner-scoped partials + the
  // querying-side one-shot/live gather — lifted to [./fold.ts] (makeFold). Built here, once its
  // injected deps exist: `invoke` (the in-process dispatcher — it does NOT depend on the engine,
  // so the wiring stays linear) plus the raw `data` proxy, the mesh, the two aggregate registries
  // the composer's onCommit/aeTimer walk, and clientSubs (a fold handle's teardown drains here).
  const fold = makeFold({ data, mesh, me, invoke, aggregateRebinds, aggregateReconciles, clientSubs })

  //! dispatch: build LAST — the RPC/subscription servers, method surfaces, remote-read handles, and data facade.
  // The dispatch surface (Milestone D/E/Q1–Q3) — the RPC + subscription servers, the local/client
  // method surfaces, the lazy remote-read handles, and the `data` facade — lifted to [./dispatch.ts]
  // (makeDispatch). Built LAST: it consumes the fold engine's entry points + `invoke` by reference
  // (linear, no forward-ref), sets context.methods, and returns the surfaces the composer wires below
  // (the mesh hooks route to dispatch.serve*; the return exposes dispatch.dataFacade/methodSurface).
  const dispatch = makeDispatch({ allMethods, defaults, context, mesh, me, scoped, R, viewSize, holds, data, clientSubs, invoke, fold })

  await mesh.ready

  return {
    data: dispatch.dataFacade,
    methods: dispatch.methodSurface,
    cluster,
    destroy() {
      void writeHost // retain the sink host until teardown
      if (aeTimer) clearInterval(aeTimer)
      viewMgr?.destroy()
      for (const unsub of clientSubs) unsub()
      mesh.destroy()
    },
    //! [diagnostics]: Symbol-keyed internals seam (off the public API) — served-sub count + drop/isolate/heal fault injection.
    // Internals seam (Symbol-keyed, off the typed/enumerable public API): observability +
    // fault-injection for tests and power users. `servedSubscriptions` is the count of live
    // subscriptions this node serves (asserts the reap of a dropped peer); `drop` abruptly closes a
    // peer's connection (no UNSUBSCRIBE — the way a real network drop looks) to exercise that reap;
    // `isolate`/`heal` are the reversible partition primitive the chaos harness uses (isolate both
    // sides for a true bidirectional cut that later heals and reconverges — see Peers.isolate).
    [diagnostics]: {
      servedSubscriptions: dispatch.servedCount,
      drop: (address: string) => mesh.drop(address),
      isolate: (address: string) => mesh.isolate(address),
      heal: (address: string) => mesh.heal(address),
    },
  } as Fero
}

//! diagnostics: the Symbol key for the internals handle, kept off the typed public surface and out of Object.keys.
// Symbol-keyed internals handle on a returned fero() instance (`instance[diagnostics]`): kept OFF
// the typed public surface (data/methods/cluster/destroy) and out of Object.keys.
export const diagnostics = Symbol('fero.diagnostics')
