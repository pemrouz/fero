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
// client `read()` projections, DHT-partitioned routing. See ../IDEAS.md.

import { $, value as VALUE, view as VIEWSYM, Operators } from '../../data/index.ts'
import { transport, type Mesh, type TransportOpts } from '../transport/index.ts'
import { Log, originKey } from '../log/partition.ts'
import { applyRecord } from '../log/index.ts'
import { partitionOf, type ChangeRecord } from '../transport/message.ts'
import { ViewManager } from './view.ts'

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
          },
        })
      : undefined
  const viewEpoch = (): number => viewMgr?.epoch ?? 1

  // Periodic anti-entropy (scoped only): the robust backstop for acquisition + drift
  // (a commit-triggered resync can race a peer that hasn't committed the new view
  // yet; this re-runs until both rings agree and the partition transfers). Off in
  // full replication (the R=∞ path is unchanged — onConnect catch-up suffices there).
  const aeTimer = scoped && me !== undefined ? setInterval(resync, antiEntropyMs) : undefined
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

  // ── Distributed aggregates (Milestone Q2) ──
  //
  // With R-way holding no single node materializes the whole resource, so an
  // aggregate over ALL of it (`data.sum('value')`) is computed partial-per-shard +
  // folded: each holder runs the aggregate LOCALLY over the partitions it OWNS,
  // streams its partial, and the querying node folds every holder's partial into the
  // global answer (the fold lands in Q2b). One row change → one partial delta → an
  // O(1) global update.
  //
  // OWNER-scoping (not holder-scoping) is the dedup: a partition lives on R replicas,
  // but has exactly ONE owner, so scoping each holder's partial to the partitions it
  // OWNS makes the union a DISJOINT cover of the keyspace — every row counted exactly
  // once regardless of R. The owner-scoped view filters the RAW `data` proxy (the
  // held partitions) to the keys we own on the committed ring; `data`'s filter passes
  // the key to its predicate (`(value, name) => …`), and ownership exactly partitions
  // the keyspace. Built over the RAW proxy, never the `dataFacade` (which would
  // recurse into remote handles).
  const ownedView = () => (data as any).filter((_v: unknown, k: string) => mesh.owner(k) === me)

  // This node's owner-scoped PARTIAL for a serializable aggregate spec ({op, col}).
  // The spec crosses the wire to every symmetric holder, which reconstructs the same
  // owner-scoped operator locally — so the NAME/shape travels, not a closure. Q2a
  // ships sum/count/max/min (string-parameterized, no fn); avg/some/every/group land
  // in later increments. Returns a `data` ViewProxy (scalar here) — snapshot for an
  // RPC, change-stream for a subscription, exactly like `read`.
  const buildPartial = (spec: any): any => {
    const owned = ownedView()
    switch (spec?.op) {
      case 'sum':
        return owned.sum(spec.col)
      case 'count':
        return owned.length()
      case 'max':
        return owned.max(spec.col)
      case 'min':
        return owned.min(spec.col)
      default:
        throw new Error(`fero: unknown aggregate op "${spec?.op}"`)
    }
  }

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
    aggregate: (spec) => buildPartial(spec),
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
  const serveCall = (method: string, arg: unknown, address: string): unknown => {
    if (method === 'read' && typeof arg === 'string' && scoped && !holds(arg)) {
      const owner = mesh.owner(arg)
      if (owner !== undefined && owner !== me) return mesh.call('read', arg, owner)
    }
    return snapshot(invoke(method, arg, address))
  }

  // Server side of a subscription: run the method here; if it returns a ViewProxy
  // (a projection — the default `read` returns the whole `data`, a custom one may
  // return `data.filter(...)`), connect a sink and stream every change (the
  // initial snapshot first, then deltas) to the subscriber. A plain value is shipped
  // once. The sink host is retained per (address, subId) so it keeps firing until
  // the client unsubscribes (data holds sinks only by WeakRef).
  const subscriptions = new Map<string, { host?: object; unsub?: () => void }>()
  const serveSubscribe = (subId: number, method: string, arg: unknown, address: string) => {
    // Read-forwarding (Q1): subscribe a non-held read key FROM the owner and relay its
    // deltas to the subscriber; the upstream unsub is closed on unsubscribe.
    if (method === 'read' && typeof arg === 'string' && scoped && !holds(arg)) {
      const owner = mesh.owner(arg)
      if (owner !== undefined && owner !== me) {
        const unsub = mesh.subscribe('read', arg, (record: ChangeRecord) => mesh.deltaTo(address, subId, record), owner)
        if (unsub) subscriptions.set(`${address}:${subId}`, { unsub })
        return
      }
    }
    let result: unknown
    try {
      result = invoke(method, arg, address)
    } catch {
      return // a failed subscription just yields no stream (RPC path surfaces errors)
    }
    if (isViewProxy(result)) {
      subscriptions.set(`${address}:${subId}`, { host: (result as any).connect({}, (change: ChangeRecord) => mesh.deltaTo(address, subId, change)) })
    } else {
      mesh.deltaTo(address, subId, { type: 'update', key: [], value: result })
    }
  }
  const serveUnsubscribe = (subId: number, address: string) => {
    const k = `${address}:${subId}`
    subscriptions.get(k)?.unsub?.() // forwarded subscription → close the upstream; local → just drop the host (sink GC'd)
    subscriptions.delete(k)
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
  // A remote-access HANDLE: a thenable (await ⇒ one-shot RPC) that is ALSO a live
  // ViewProxy (reactive use ⇒ a server-pushed subscription). `to()` picks the target
  // peer lazily — a specific owner (owner-routed reads) or undefined ⇒ a picked
  // connected server. `then` is the only access that does NOT subscribe.
  const makeHandle = (method: string, arg: unknown, to?: () => string | undefined, writeKey?: string) => {
    let live: any // the local ViewProxy, created (and the subscription opened) lazily
    const ensure = () => {
      if (live) return
      live = $({})
      const res = (live as any)[VIEWSYM].res
      const unsub = mesh.subscribe(method, arg, (record: ChangeRecord) => applyRecord(res, record), to?.())
      if (unsub) clientSubs.add(unsub)
    }
    return new Proxy(noop, {
      get(_t, prop) {
        if (prop === 'then') return (onF: any, onR: any) => mesh.call(method, arg, to?.()).then(onF, onR) // await ⇒ one-shot RPC
        if (typeof prop === 'symbol' && prop !== VIEWSYM && prop !== VALUE) return undefined // ignore JS-internal probes
        if (prop === 'constructor' || prop === 'toJSON') return undefined
        ensure() // any real data/operator access ⇒ subscribe + delegate to the live proxy
        return live[prop]
      },
      // Nested write into a non-held partition (`data.x.y = v`): route to the RAW proxy
      // so it flows through the write-capture sink → owner. Only the READ handle carries
      // a writeKey (a method handle has none — set is a harmless no-op). Depth-1 only;
      // deeper writes into a non-held partition aren't routed (use a top-level assignment
      // `data.x = {…}` or the holding node) — a documented first-cut limitation.
      set(_t, prop, v) {
        if (writeKey !== undefined && typeof prop === 'string') (data as any)[writeKey][prop] = v
        return true
      },
    })
  }
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
  const dataFacade =
    scoped || isClient
      ? new Proxy(data, {
          get(t, prop) {
            if (typeof prop === 'symbol' || isOperator(prop as string) || BUILTIN.has(prop as string)) return (t as any)[prop]
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
  }
}

// noop target for the callable client-handle Proxy (mirrors data's ViewProxy).
const noop = () => {}

// A `data` ViewProxy carries the view symbol; a plain value does not.
function isViewProxy(v: unknown): boolean {
  return v != null && (typeof v === 'object' || typeof v === 'function') && (v as any)[VIEWSYM] !== undefined
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
