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
import { transport, type Mesh, type TransportOpts, type WriteOutcome } from '../transport/index.ts'
import { Log, originKey, versionKey } from '../log/log.ts'
import { applyRecord } from '../log/index.ts'
import { partitionOf, type ChangeRecord } from '../transport/message.ts'
import { ViewManager } from './membership.ts'
import { makeFold } from './fold.ts'
import { makeDispatch } from './dispatch.ts'
import { makeSnapshot, peerValue, type InspectSnapshot } from './inspect.ts'
import { makeObserve, type Observe, type ObserveOpts } from './observe.ts'
import { makeWritesLog, type WritesLog } from './writes.ts'

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
  readonly writes: any // confirm-write lifecycle ViewProxy (in-flight + per-tier latency) — gated, lazily built on first access (resource/writes.ts); records ONLY confirm:'accepted'|'committed'|'replicated' writes, never fire-and-forget
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

//! Storage: the durable-log seam (plan §4) — load() replays at boot, append() persists each accepted record (sync OR async — confirm:'persisted' awaits the returned Promise).
// Durable-log seam (plan §4). `load` returns the persisted records at boot (they
// replay through the same accept path as inbound replication); `append` persists
// each accepted record. A built-in file adapter lives in ./storage.ts; bring your
// own (Redis, S3, a DB WAL) by implementing these two.
//
// `append` may return a Promise: it resolves when the record is durable TO THE
// EXTENT THIS SEAM GUARANTEES. confirm:'persisted' (DECISIONS Z) keys its W-quorum
// off that resolution — a replica acks the durable-probe only once its append
// resolved — so the strength of 'persisted' is exactly the strength of the seam you
// plug in: a sync seam (returns void) is treated as durable-on-return; an fsync'd
// WAL survives power loss; the built-in fileStorage reaches the OS page cache
// (survives a process crash, not power loss). An append-ordered seam is assumed
// (append(N) durable ⇒ append(<N) durable — true for any WAL); the high-water that
// answers a durable-probe relies on it.
export type Storage = {
  load: () => ChangeRecord[] | Promise<ChangeRecord[]>
  append: (record: ChangeRecord) => void | Promise<void>
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
  //! compactMs: periodic log-compaction interval (collapse superseded same-key updates); 0 disables. Both replication modes.
  // Log compaction interval (ms): periodically collapse a partition's superseded
  // same-key updates so a high-churn key doesn't grow the log without bound (see
  // Log.compact). Runs in BOTH full and scoped modes (every node's log accumulates
  // its own + replicated writes) on an unref'd timer, OFF the write hot path. `compact:
  // false` (or 0) disables it; default 30s — infrequent because it's an O(partitions)
  // sweep and the win is steady-state memory, not latency. Extracted + deleted so it
  // never reaches the transport.
  const compactMs =
    config.compact === false ? 0 : typeof config.compact === 'number' ? (config.compact as number) : 30_000
  delete (config as any).compact

  //! observe: opt-in L4 diagnostics — registers the wire-reachable __inspect pull method (off by default; trust boundary in ../IDEAS.md).
  // The L4 observer seam (plan.md L4). When set, register the `__inspect` method so a
  // remote observer can pull this node's InspectSnapshot over the wire. OFF by default:
  // a configured node discloses its full internals to any peer that can reach the
  // (unauthenticated) fero port, so observation is opt-in — the open trust-boundary
  // refinement (loopback-only / `peer.auth`) is tracked in ../IDEAS.md. The in-process
  // diagnostics seam ([diagnostics].snapshot) is ALWAYS available (holding the object
  // reference is already full trust); only the WIRE path is gated. Extracted + deleted
  // here so it never reaches the transport. (true | an options object ⇒ on.)
  const observeOpt = config.observe
  delete (config as any).observe
  const observeOn = observeOpt === true || (typeof observeOpt === 'object' && observeOpt !== null)
  //! observeVerbose: also stream dedup-drops (the highest-frequency, least-useful event) — OFF by default even when observe is on (plan §6).
  const observeVerbose = typeof observeOpt === 'object' && observeOpt !== null && (observeOpt as ObserveOpts).verbose === true
  //! snapshot: forward-declared so `defaults.__inspect` can close over it; assigned after dispatch (its servedCount dep) exists.
  let snapshot: (opts?: { sample?: string[] }) => InspectSnapshot = () => {
    throw new Error('fero: inspect snapshot not ready')
  }

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
  // as the anti-entropy digest a node sends (Object.fromEntries(seen)). It advances
  // even for a permanent epoch-loser applyInbound SKIPS logging, so it can EXCEED
  // log.marks() (the shippable high-water) by exactly those dead seqs — that's why
  // shedConfirmed compares peers against log.marks(), not seen.
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

  //! versionKey (imported from log/log.ts): the key a record contends on for LWW — shared with the log so compaction collapses EXACTLY the records LWW treats as one cell.

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
  // per-origin high-water. (2) Log every accepted record EXCEPT a permanent
  // epoch-loser (a key already holds a higher-epoch winner — see applyInbound's
  // epoch-skip); the log is the per-origin history catch-up forwards from. (3) Apply
  // only LWW winners to the proxy — a same-epoch loser stays logged, a lower-epoch
  // loser is skipped entirely, neither mutates state. The apply re-emits through the
  // write-capture sink; the `applying` guard stops that re-emission from being
  // re-logged or re-broadcast.
  let applying = false
  //! committingForward: guard so an applied forwarded write commits as-is, never re-evaluating ownership.
  // Set while a FORWARDED write is being applied locally (see commitForwarded): the
  // sink commits it as-is instead of re-evaluating ownership, so it never bounces.
  let committingForward = false
  //! discarding: partitions whose optimistic copy we're dropping (scoped non-holder) — a Set, NOT a boolean, because data DEFERS the re-entrant remove past a boolean guard's lifetime.
  // discardOptimistic drops a foreign partition's optimistic value by writing a `remove`
  // to the proxy. But data's transact DEFERS a re-entrant write — one issued from inside
  // a cascade, which the write-capture sink IS — to a _pending drain that runs AFTER the
  // issuing call returns. So an `applying = true` boolean set around that remove is back
  // to false by the time the deferred remove re-emits through the sink: the guard misses
  // it, the sink treats it as a genuine write, and forwards a spurious `remove` to the
  // owner — deleting the just-written value cluster-wide (the scoped-non-holder lost
  // write, surfaced when data switched re-entrant writes from inline to deferred). A Set
  // keyed by partition SURVIVES the drain: the sink consumes the entry when the remove
  // arrives (inline OR deferred), dropping it exactly once, never forwarding it. It is
  // cleared synchronously within the same outer cascade (transact drains _pending before
  // returning), so it can't swallow a later genuine remove of the same key.
  const discarding = new Set<string>()
  //! lastCommit: the outcome of the most recent commitLocal — commitForwarded reads it to report committed/withheld + seq/epoch back to the forwarder (the honest WRITE-ACK).
  // commitLocal runs INSIDE the write-capture sink, whose return value the data proxy
  // discards — so commitForwarded can't read it directly. commitLocal stashes its outcome
  // here on each run, and commitForwarded reads it right after the (synchronous, un-
  // cascaded) apply. undefined ⇒ the apply was a no-op (the value was already present) ⇒
  // idempotently committed.
  let lastCommit: WriteOutcome | undefined
  //! confirmHook: a one-shot resolver claimed by the NEXT write the sink routes — how `methods.update({…, confirm:'committed'})` learns its write's outcome.
  // writeWithConfirm sets this immediately before issuing a confirmed write; the sink
  // claims it (clears it) for that one write and fires it with the terminal WriteOutcome:
  // synchronously for an owned commit (commitLocal), or via the forward's onOutcome ACK.
  // Single shared slot is safe — a write's apply→sink runs synchronously inside the
  // issuing call (un-cascaded), so two confirmed writes never overlap. undefined for
  // every fire-and-forget write (the default) and every inbound/forwarded apply.
  let confirmHook: ((outcome: WriteOutcome) => void) | undefined

  //! ── confirm:'replicated' — writer-side W-quorum probe of the R-set (ordering-safe; DECISIONS Z) ──
  // The record replicates normally (in-order, untouched hot path). To confirm it reached
  // W replicas, the WRITER probes the key's R-set with (origin, seq) — the committed point
  // yields both — and counts acks. Owner-write and forwarded-write unify: same probe phase
  // after committed. A probe rides a point-to-point control frame (REPL_PROBE), NOT the
  // ordered data stream, so it can't perturb replication; a replica HOLDS a probe it can't
  // yet satisfy until applyInbound catches its high-water up to seq (so it's robust even if
  // the record arrives later via anti-entropy). W is the majority of the effective replica
  // count — the same majority the ViewManager view-change uses.
  let replCid = 0
  //! replTally: cid → the in-flight W-quorum count for one replicated/persisted confirm — probe context (partition/origin/seq) + durable flag + the targets probed + distinct acks; settle when `needed` reached, on timeout, or on a view-change recount.
  const replTally = new Map<number, { partition: string; origin: string; seq: number; durable: boolean; probed: Set<string>; got: Set<string>; needed: number; settle: (ok: boolean) => void; timer: ReturnType<typeof setTimeout> }>()
  //! pendingProbes: a replica's HELD probes (arrived before the record) keyed by seenKey — acked when the matching high-water (seen for replicated, persisted for durable) advances to seq; a bounded TTL drops a never-satisfied one.
  const pendingProbes = new Map<string, { seq: number; cid: number; from: string; durable: boolean; timer: ReturnType<typeof setTimeout> }[]>()
  //! persisted: per-seenKey DURABLE high-water — max seq whose storage.append RESOLVED (bumped in onPersisted). confirm:'persisted' keys its W-quorum off this; empty/unused without storage or persisted writes.
  const persisted = new Map<string, number>()
  //! localPersistWaiters: this node's OWN confirm:'persisted' writes waiting on its local append to resolve before probing the rest of the R-set (drained by onPersisted; a per-waiter timeout fails the confirm).
  const localPersistWaiters: { sk: string; seq: number; cb: () => void; timer: ReturnType<typeof setTimeout> }[] = []
  //! replQuorum: W = majority of the effective replica count (min(R, view)) — the owner counts as 1 toward it; min() first so Infinity>>1 (=0) can't underflow it.
  const replQuorum = (): number => (Math.min(R, viewSize() || 1) >> 1) + 1

  //! probeReplicated: phase 2 of confirm:'replicated'/'persisted' — count what we already have, probe the rest of the R-set, settle(true) at W, settle(false) on timeout (→ reject 'quorum').
  // `durable` ⇒ confirm:'persisted': we count `me` only because the caller already
  // awaited OUR local append (awaitLocalPersist), and the owner is NOT free (committed
  // ≠ durable — the WRITE-ACK fires before storage.append resolves), so it's probed too,
  // with durable=true. Non-durable (replicated) keeps the original count: owner + us are
  // free (they hold the canonical record once committed).
  const probeReplicated = (partition: string, origin: string, seq: number, settle: (ok: boolean) => void, timeoutMs: number, durable = false) => {
    const rset = mesh.owners(partition, R)
    const ownerAddr = mesh.owner(partition)
    const W = replQuorum()
    let have = 0 // replicas known to hold it without a probe
    const targets: string[] = []
    for (const a of rset) {
      if (a === me) have++ // us: replicated ⇒ we hold it; persisted ⇒ the caller awaited our local append before probing
      else if (a === ownerAddr && !durable) have++ // replicated: the owner holds the canonical record post-commit; persisted: probe it (durable) — committed ≠ durable
      else targets.push(a)
    }
    if (have >= W || targets.length === 0) return settle(have >= W) // already at W (single node / R=1 / small view) or nobody left to probe
    const cid = ++replCid
    const timer = setTimeout(() => {
      if (replTally.delete(cid)) settle(false) // never reached W in time → reject 'quorum' (the write IS committed; only the stronger bar was missed)
    }, timeoutMs)
    timer.unref?.()
    replTally.set(cid, { partition, origin, seq, durable, probed: new Set(targets), got: new Set(), needed: W - have, settle, timer })
    for (const a of targets) mesh.replProbe(a, cid, { origin, seq, partition, durable })
  }

  //! recountProbes: a view committed mid-probe — re-evaluate every in-flight replicated confirm against the NEW R-set/W instead of waiting on the per-cid timer.
  // Membership churn invalidates probeReplicated's one-time R-set snapshot: a probe
  // target can be evicted (it'll never ack — the timer would otherwise be the only way
  // out), and a NEW member can rotate into the R-set (never probed, so the only path to
  // W is now unreachable without re-probing). For each tally: recompute the R-set, owner,
  // and W under the new ring; drop acks/probes from members no longer in the R-set
  // (durability is "W of the CURRENT R-set", so an evicted holder no longer counts);
  // settle(true) at once if the survivors already meet W; otherwise probe the freshly-
  // admitted R-set members (they acquire the partition via resync, then ack). The per-cid
  // timer is left armed as the liveness backstop for the genuine can't-reach-W case.
  const recountProbes = () => {
    if (!replTally.size) return // zero-cost when no replicated confirm is in flight (the common case)
    for (const [cid, t] of replTally) {
      const rset = new Set(mesh.owners(t.partition, R))
      const ownerAddr = mesh.owner(t.partition)
      // free = R-set members known to hold it without a probe. us, always (replicated: we hold it;
      // persisted: our local append was awaited before this probe began). the owner too, but ONLY
      // for replicated — for persisted the owner must prove durability, so it stays a probe target.
      const isFree = (a: string) => a === me || (a === ownerAddr && !t.durable)
      let free = 0
      for (const a of rset) if (isFree(a)) free++
      // an ack/probe from a member the new R-set dropped no longer counts toward "W of the CURRENT R-set holds it"
      t.got = new Set([...t.got].filter((a) => rset.has(a) && !isFree(a)))
      t.probed = new Set([...t.probed].filter((a) => rset.has(a) && !isFree(a)))
      const W = replQuorum()
      t.needed = Math.max(0, W - free)
      if (free + t.got.size >= W) {
        clearTimeout(t.timer)
        replTally.delete(cid)
        t.settle(true) // the survivors already satisfy W under the new view — resolve now, don't wait for the timer
        continue
      }
      for (const a of rset) // probe any newly-admitted R-set member (they'll acquire the partition via resync, then ack)
        if (!isFree(a) && !t.probed.has(a)) {
          t.probed.add(a)
          mesh.replProbe(a, cid, { origin: t.origin, seq: t.seq, partition: t.partition, durable: t.durable })
        }
    }
  }

  //! recvReplAck: a probed replica confirms it holds (origin,seq) — count distinct acks; at `needed` the W quorum is reached.
  const recvReplAck = (cid: number, address: string) => {
    const t = replTally.get(cid)
    if (!t) return // already settled (quorum reached or timed out)
    t.got.add(address)
    if (t.got.size >= t.needed) {
      clearTimeout(t.timer)
      replTally.delete(cid)
      t.settle(true)
    }
  }

  //! recvReplProbe: ack now if our high-water already covers (origin,seq); else HOLD the probe (a TTL drops a never-satisfied one — by then the prober timed out).
  // The high-water that matters depends on the probe: replicated reads `seen` (the record is
  // APPLIED/held); persisted (durable) reads `persisted` (storage.append RESOLVED). A durable
  // probe is held in the SAME list but tagged, so the matching advance (applyInbound vs onPersisted)
  // drains it.
  const recvReplProbe = (cid: number, probe: { origin: string; seq: number; partition: string; durable?: boolean }, from: string) => {
    const sk = seenKey(probe.origin, probe.partition)
    const durable = probe.durable === true
    const hw = durable ? (persisted.get(sk) ?? 0) : (seen.get(sk) ?? 0)
    if (hw >= probe.seq) return void mesh.replAck(from, cid)
    let list = pendingProbes.get(sk)
    if (!list) pendingProbes.set(sk, (list = []))
    const timer = setTimeout(() => {
      const l = pendingProbes.get(sk)
      if (!l) return
      const i = l.findIndex((p) => p.cid === cid)
      if (i >= 0) l.splice(i, 1)
      if (!l.length) pendingProbes.delete(sk)
    }, 30_000)
    timer.unref?.()
    list.push({ seq: probe.seq, cid, from, durable, timer })
  }

  //! probeReady: a high-water advanced (origin,partition) to `n` — ack + drop every held probe of the MATCHING kind now satisfied. `durable` selects which (seen→replicated, persisted→durable).
  const probeReady = (sk: string, n: number, durable: boolean) => {
    const list = pendingProbes.get(sk)
    if (!list) return
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].durable === durable && list[i].seq <= n) {
        clearTimeout(list[i].timer)
        mesh.replAck(list[i].from, list[i].cid)
        list.splice(i, 1)
      }
    }
    if (!list.length) pendingProbes.delete(sk)
  }

  //! onPersisted: storage.append for (origin,partition,seq) RESOLVED — advance the DURABLE high-water + release every durable probe / local waiter it now satisfies (confirm:'persisted').
  const onPersisted = (sk: string, seq: number) => {
    if (seq <= (persisted.get(sk) ?? 0)) return // an out-of-order/older resolution — already covered (append-ordered seam: a later durable seq implies the earlier ones)
    persisted.set(sk, seq)
    if (pendingProbes.size) probeReady(sk, seq, true) // a REMOTE replica's durable probe we were holding
    for (let i = localPersistWaiters.length - 1; i >= 0; i--) {
      const w = localPersistWaiters[i]
      if (w.sk === sk && w.seq <= seq) {
        clearTimeout(w.timer)
        localPersistWaiters.splice(i, 1)
        w.cb() // OUR own write is now locally durable → start probing the rest of the R-set
      }
    }
  }

  //! awaitLocalPersist: confirm:'persisted' on a HOLDER — run `ready` once OUR local append for (sk,seq) resolves (immediately if already durable); `timedOut` if it never does within the budget.
  const awaitLocalPersist = (sk: string, seq: number, timeoutMs: number, ready: () => void, timedOut: () => void) => {
    if ((persisted.get(sk) ?? 0) >= seq) return ready()
    const w = { sk, seq, cb: ready, timer: undefined as unknown as ReturnType<typeof setTimeout> }
    w.timer = setTimeout(() => {
      const i = localPersistWaiters.indexOf(w)
      if (i >= 0) localPersistWaiters.splice(i, 1)
      timedOut()
    }, timeoutMs)
    w.timer.unref?.()
    localPersistWaiters.push(w)
  }

  //! observe: the L4 push-hook gate — null until the first __observe subscriber arms it, nulled again when the last one leaves (zero-cost when unwatched).
  // The contention/provenance push channel (resource/observe.ts). Built LAZILY on the
  // first subscribe and nulled on the last detach, so the emit-sites below are a single
  // `observe?.…` predicted-false branch whenever nobody is watching — the steady-state
  // write path is untouched (guarded in observe.perf.ts).
  let observe: Observe | undefined
  //! writesLog: the cluster.writes gate — null until the first `cluster.writes` access builds it; the confirm emit-sites are a `writesLog?.…` predicted-false branch until then. Stays armed (bounded ring, off the steady path — see writes.ts).
  let writesLog: WritesLog | undefined
  //! buildObserve: lazily construct + arm the push-hook for ONE subscriber; returns the proxy to stream + the close that disarms the gate on the last detach.
  // The close is per-subscriber IDEMPOTENT (a `closed` latch) and captures the INSTANCE
  // it attached to — a stale closer that fires after the gate was disarmed and re-armed
  // must not decrement the NEW instance's refcount (it would disarm the gate under a
  // live subscriber) nor null a gate it doesn't own.
  const buildObserve = () => {
    const inst = (observe ??= makeObserve(typeof observeOpt === 'object' && observeOpt !== null ? (observeOpt as ObserveOpts) : {}))
    inst.attach()
    let closed = false
    return {
      proxy: inst.proxy,
      close: () => {
        if (closed) return // double-close (graceful UNSUBSCRIBE + socket-close, or a user double-call) is a no-op
        closed = true
        if (inst.detach() && observe === inst) observe = undefined // last subscriber gone → disarm OUR instance only
      },
    }
  }

  //! applyInbound: dedup → Lamport-merge → epoch-skip | log → LWW-resolve → apply winner; shared by replication + restore replay.
  // Accept a record into local state: dedup by per-origin high-water, Lamport-merge
  // the clock, SKIP a permanent epoch-loser (a key that already holds a higher-epoch
  // winner — not logged), else log it (per-origin history), LWW-resolve, and apply the
  // winner to the proxy. Shared by inbound replication AND restore-from-storage replay
  // — neither path broadcasts (the sink's `applying` guard keeps the re-emission from
  // looping back out, and restore runs before any peer exists).
  const applyInbound = (record: ChangeRecord) => {
    const origin = record.origin
    if (origin !== undefined) {
      const sk = seenKey(origin, partitionOf(record))
      const n = record.seq ?? 0
      if (n <= (seen.get(sk) ?? 0)) {
        if (observeVerbose) observe?.onRecord(record, 'dropped') // verbose-only: the re-delivery firehose stays OFF the steady path (default off even when observe is on)
        return // already have it (dedup, per seenKey granularity)
      }
      seen.set(sk, n) // dedup high-water — advances even for the epoch-loser SKIPPED below, so anti-entropy never re-fetches that dead record
      if (pendingProbes.size) probeReady(sk, n, false) // confirm:'replicated' — our APPLIED high-water advanced; ack any held (non-durable) probe it now satisfies (zero-cost when no probes held). The DURABLE high-water advances later, in onPersisted.
      if (n > clock) clock = n // Lamport merge (global)
      const e = record.epoch ?? 0
      const key = versionKey(record)
      const cur = versions.get(key)
      //! Epoch-aware catch-up: a STRICTLY-lower-epoch record is a permanent loser (epoch fence) — skip logging AND applying.
      // We already hold + logged a higher-epoch winner for this key (cur.epoch > e), so
      // this record can NEVER win LWW (Milestone V1d fences a superseded view). Logging
      // it would only retain dead history that the next catch-up re-ships, so skip it
      // entirely. SAFE by construction: we skip ONLY when we hold the dominating winner,
      // so no live value is ever absent — only a superseded copy is dropped. And because
      // each (origin,partition) stream arrives IN ORDER from its single owner, `seen`
      // advancing past a skipped seq still honestly means "every live value ≤ this seq is
      // present" (a live value below it was processed — and logged — earlier in the run).
      if (cur && e < cur.epoch) {
        observe?.onRecord(record, 'lost', { we: cur.epoch, ws: cur.seq }) // epoch-fenced loser — NOT logged (unlike the same-epoch loser below)
        return
      }
      log.append(record)
      //! LWW resolve, lexicographic (epoch, seq, origin): epoch fences stale views, seq then origin decide; a same-epoch loser stays logged.
      // LWW, lexicographic (epoch, seq, origin): a write committed under a NEWER
      // membership view wins (epoch fencing — Milestone V1d), so a straggler from
      // a superseded view can't clobber the current one; within a view (constant
      // epoch) the Lamport seq decides; origin uuid breaks exact ties. Every node
      // elects the same winner. A SAME-epoch loser stays logged (per-origin history);
      // a strictly-lower-epoch loser was already skipped above (never logged).
      if (cur && !(e > cur.epoch || (e === cur.epoch && (n > cur.seq || (n === cur.seq && origin > cur.origin))))) {
        observe?.onRecord(record, 'lost', { we: cur.epoch, ws: cur.seq }) // LWW LOSER — stays logged but never applied; carry the winner stamp so the surface shows WHY
        return
      }
      if (cur) {
        cur.epoch = e
        cur.seq = n
        cur.origin = origin
      } else versions.set(key, { epoch: e, seq: n, origin })
      observe?.onRecord(record, 'won') // an inbound replicated record that WON LWW (applied just below)
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
  let storageUnsub: (() => void) | undefined
  if (storage) {
    for (const record of await storage.load()) applyInbound(record)
    // Persist every accepted record (local OR inbound). confirm:'persisted' keys its
    // W-quorum off when the append RESOLVES — so bump the DURABLE high-water then: now
    // for a sync seam (durable on return), on the Promise for an async one. A rejected
    // async append simply doesn't advance it (the durable-probe times out → 'quorum',
    // honest: it is NOT durable). Provenance-less records (handshake) aren't tracked.
    storageUnsub = log.onAppend((record) => {
      const r = storage.append(record)
      const origin = record.origin
      if (origin === undefined) return
      const sk = seenKey(origin, partitionOf(record))
      const seq = record.seq ?? 0
      if (r && typeof (r as Promise<void>).then === 'function') (r as Promise<void>).then(() => onPersisted(sk, seq), () => {})
      else onPersisted(sk, seq)
    })
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
      else flushClientPending() // a CLIENT (re)connected a server — drain writes buffered while unreachable
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
    //! onReplProbe/onReplAck: confirm:'replicated' — answer a probe once caught up; tally a replica's ack toward the W quorum.
    onReplProbe: (cid, probe, address) => recvReplProbe(cid, probe, address),
    onReplAck: (cid, address) => recvReplAck(cid, address),
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
          onWritable: (w) => {
            if (w) flushPending()
            observe?.onWritable(w) // CHAINED: surface the write-gate flip on the provenance ticker (off the per-record path)
          },
          onCommit: () => {
            heldCache.clear() // the ring changed — invalidate the holds() memo
            markOrphans() // ring rebalanced → note partitions we no longer replicate (shed once handed off)
            resync() // ...and re-sync the ones we now acquire
            for (const rescope of aggregateRebinds) rescope() // re-scope live owner-scoped partials over the new ring (Q2c)
            for (const reconcile of aggregateReconciles) reconcile() // add/drop fold holders for the new membership
            recountProbes() // confirm:'replicated' — re-evaluate in-flight probes against the new R-set (evicted target → re-probe new members / settle now; not the timer)
            observe?.onView(viewEpoch(), viewSize()) // CHAINED: surface the new committed view on the provenance ticker
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

  //! compactTimer (both modes): periodic log compaction — collapse superseded same-key updates so a hot key can't grow the log unbounded.
  // Periodic log compaction (Log.compact): collapse a partition's superseded same-key
  // updates. Unlike aeTimer this runs in BOTH modes — every node's log accumulates the
  // writes it holds (its own + replicated), and a high-churn key grows it without bound
  // regardless of R. Unref'd + off the write hot path (the append path is untouched);
  // the proxy stays the source of truth, so dropping dead log history never affects a
  // read. Gated only on compactMs (0 = disabled).
  const compactTimer = compactMs > 0 ? setInterval(() => void log.compact(), compactMs) : undefined
  compactTimer?.unref?.()

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
  // destroyed: latched by destroy() — data's FunctionSink has no public detach (it is pinned via
  // the anchor's lifetime), so without this gate a write AFTER destroy would still commit: bump
  // the Lamport clock, mutate seen/versions, append to the log, and fsync to the WAL — silently,
  // on a torn-down node. One predictable boolean branch alongside primed/applying.
  let destroyed = false
  const writeHost = data.connect({}, (change: ChangeRecord) => {
    //! 0) destroyed-skip: the node is torn down — a late write must not commit/persist.
    if (destroyed) return

    //! 1) prime: swallow the empty attach-snapshot.
    // 1) prime: swallow the empty attach-snapshot.
    if (!primed) {
      primed = true
      return
    }

    //! 2) applying-skip: an inbound re-emission — already handled in onRecord.
    // 2) applying-skip: an inbound re-emission — already handled in onRecord.
    if (applying) return

    //! 2b) discard-skip: a deferred optimistic-discard for a non-held partition — drop it silently (no forward, no commit). See `discarding`.
    // discardOptimistic issued this `remove` as local cleanup of an optimistic value we
    // already forwarded to the owner; data deferred it past the `applying` boolean, so we
    // catch it here by partition. Consume the entry (delete returns true iff present) and
    // drop the record — it must never be forwarded as a write or committed-local.
    if (change.type === 'remove' && discarding.delete(partitionOf(change))) return

    //! 2c) claim the confirm resolver for THIS write (the committed tier) — undefined for a fire-and-forget write; the discard-remove re-fire (2b) returns above, never reaching here.
    const hook = confirmHook
    confirmHook = undefined

    //! 3) routing: a CLIENT forwards to a server; a server forwards to the owner (F1) — both ack-confirmed.
    if (!committingForward) {
      const p = partitionOf(change)
      //! 3a) CLIENT (no ViewManager ⇒ viewEpoch ≡ 1): never commit under own provenance — forward to a server, then DROP the optimistic copy.
      // A client committing locally stamps epoch 1 forever; any FORMED cluster (epoch ≥ 2)
      // sticky-fences such a record wherever a server-written winner exists (B1 skip), while
      // the client applies it locally — silent permanent divergence. Route the write to a
      // connected server instead: it re-sequences under ITS provenance/epoch (its
      // committingForward guard commits as-is, no re-route ping-pong). Unreachable or
      // unconfirmed ⇒ buffer (bounded drop-oldest), flushed on (re)connect + a periodic sweep.
      // Then DISCARD the optimistic copy: a client holds NOTHING (no ViewManager, inbound-
      // only, no replication/anti-entropy), and read subscriptions land on a SEPARATE proxy
      // — so a kept copy is never reconciled and becomes a permanent client-local STALE READ
      // on data[value]/operators after the cluster moves the key on. Keyed reads already
      // route remotely (holds()≡false ⇒ remoteRead), so dropping it changes only the raw-
      // snapshot/operator surface (stale → honestly-empty), not `await data.x`. Read-your-
      // writes for a client is `await methods.update({…, confirm})` then read (the confirm
      // surface), not a sticky local shadow. The discard rides `discarding` (2b), so the
      // proxy remove is dropped locally and never forwarded to the server.
      if (me === undefined) {
        forwardToServer(change, hook)
        discardOptimistic(p)
        return
      }
      // 3b) F1 forward: not owner + owner reachable ⇒ hand off, CONFIRMED by WRITE-ACK.
      // Socket-write success ≠ delivery: an owner crash inside the failure-detector lag accepts
      // the frame into a dying kernel buffer — and a scoped non-holder had already discarded its
      // optimistic copy, so the write held NOTHING anywhere (silent loss, the never-drop
      // violation). The ack-confirmed forward keeps a never-drop fallback armed: no ACK within
      // callTimeout ⇒ commit under OUR provenance (an orphan on a non-holder — P4 sheds it once
      // the R-set confirms; a duplicate when only the ack was lost converges via LWW).
      const owner = mesh.owner(p)
      if (
        owner !== undefined &&
        owner !== me &&
        mesh.forward(owner, change, (outcome) => {
          if (outcome.committed) hook?.(outcome) // owner sequenced it ⇒ resolve the confirm with {seq, epoch}
          else {
            commitLocal(change) // withheld (quorum-less owner) or timeout ⇒ never-drop fallback under OUR provenance
            hook?.({ committed: false, seq: lastCommit?.seq, epoch: lastCommit?.epoch, reason: outcome.reason }) // reject: committed-LOCALLY-but-unconfirmed when lastCommit.seq is set, else nothing committed (we're also quorum-less)
          }
        })
      ) {
        // P2: forwarded a write for a partition we DON'T replicate — drop the optimistic value (the
        // owner replicates to the R-set, not us; reading this key is a Q1 remote read). Full
        // replication keeps it: the canonical record returns and reconciles. (The never-drop
        // fallback above logs/replicates WITHOUT re-applying — a non-held partition stays
        // un-materialized locally by design.)
        if (scoped && !holds(p)) discardOptimistic(p)
        return
      }
    }

    //! 4) commit-local: stamp/log/replicate under our provenance.
    // 4) commit-local: stamp/log/replicate under our provenance.
    commitLocal(change)
    hook?.(lastCommit ?? { committed: true }) // an owned write committed synchronously (or a no-op apply ⇒ idempotently committed); withheld when quorum-less (lastCommit.committed false)
  })

  //! ── client write path (#3): forward to a picked server; buffer (bounded) when unreachable/unconfirmed ──
  const bufferClientWrite = (change: ChangeRecord) => {
    if (pending.length >= MAX_PENDING) pending.shift() // bounded: drop oldest (same posture as the V1e write-gate buffer)
    pending.push(change)
  }
  const forwardToServer = (change: ChangeRecord, hook?: (o: WriteOutcome) => void) => {
    const server = mesh.pickServer()
    if (
      server === undefined ||
      !mesh.forward(server, change, (outcome) => {
        if (!outcome.committed) bufferClientWrite(change) // withheld (quorum-less server) or timeout ⇒ re-buffer, retry via the flush sweep
        hook?.(outcome) // resolve/reject a client confirm:'committed' on the server's outcome
      })
    )
      bufferClientWrite(change) // no server reachable: buffered for the flush sweep; a confirm (if any) times out in writeWithConfirm
  }
  //! flushClientPending: drain the client buffer once a server is reachable (onConnect + a periodic unref'd sweep).
  const flushClientPending = () => {
    if (me !== undefined || !pending.length || mesh.pickServer() === undefined) return
    const batch = pending.splice(0)
    for (const c of batch) forwardToServer(c) // failures re-buffer
  }
  const clientFlushTimer = me === undefined ? setInterval(flushClientPending, antiEntropyMs) : undefined
  clientFlushTimer?.unref?.()

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

  //! discardOptimistic: drop a forwarded-but-unheld partition's optimistic value — via `discarding` (survives data's deferred re-entrant drain; the old `applying` boolean did not).
  // Silently remove a foreign partition we optimistically applied but don't hold (after
  // forwarding its write to the owner). Mark the partition in `discarding` FIRST, then
  // write the proxy remove: whether data runs that remove inline (shed — called outside
  // a cascade) or defers it (the write-capture sink — called inside the user-write
  // cascade), the sink's discard-skip (2b) consumes the entry and drops it, so there's
  // no echo and no spurious forwarded 'remove'. (The old `applying = true` wrapper missed
  // the DEFERRED case, which forwarded the remove and deleted the just-written value
  // cluster-wide — the scoped-non-holder lost write.)
  const discardOptimistic = (partition: string) => {
    discarding.add(partition)
    applyRecord(res, { type: 'remove', key: [partition] })
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
    // Confirm against the LOG's shippable high-water, NOT `seen`: epoch-aware catch-up
    // advances `seen` past records it SKIPS logging (permanent epoch-losers), so `seen`
    // can claim seqs we can never re-ship — requiring a peer to reach them would hang the
    // shed forever (no holder logged that dead record). log.marks() is exactly the live
    // values we must confirm an R-set member holds before dropping our copy (shedding at
    // the lower mark is safe: the skipped seqs are superseded — the peer has their winner).
    const shippable = log.marks()
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
      lastCommit = { committed: false } // WITHHELD: quorum-less write-gate buffered it (not stamped/logged/replicated) — a forwarder's never-drop fallback must fire, not a false ack
      return
    }
    const n = ++clock
    change.origin = uuid
    change.seq = n
    const p = partitionOf(change)
    const key = versionKey(change)
    const cur = versions.get(key)
    //! epoch-dominance stamp: never commit a key BELOW the epoch of the winner we already hold.
    // A node whose committed view lags (a missed/in-flight VIEW_COMMIT, the join window) would
    // otherwise stamp viewEpoch() < cur.epoch on a key it KNOWINGLY overwrites — every peer
    // holding the newer-epoch winner then sticky-fences the record (B1 skip, seen advances), while
    // we keep it locally: silent per-key divergence until the next write. A local write happening
    // NOW against locally-known state is not a stale-view straggler (the thing V1d fences) — it
    // deliberately supersedes cur, so it commits at max(view, cur.epoch); the merged Lamport seq
    // (clock ≥ cur.seq, so n > cur.seq) wins LWW within that epoch on every replica.
    const ve = viewEpoch()
    const e = (change.epoch = cur && cur.epoch > ve ? cur.epoch : ve)
    seen.set(seenKey(uuid, p), n)
    if (cur) {
      cur.epoch = e
      cur.seq = n
      cur.origin = uuid
    } else versions.set(key, { epoch: e, seq: n, origin: uuid })
    lastCommit = { committed: true, seq: n, epoch: e, origin: uuid } // COMMITTED: stamped + about to log/replicate — the honest WRITE-ACK payload (origin lets a confirm:'replicated' prober probe the R-set for (origin,seq))
    log.append(change)
    // A committed write under OUR provenance. Forwarded writes funnel through here too
    // (commitForwarded → sink → commitLocal), so `committingForward` distinguishes a
    // peer-routed write from a genuinely-local one — emitting at BOTH sites would
    // double-count every forward. Both are LWW winners (we are the sequencer).
    observe?.onRecord(change, committingForward ? 'forwarded' : 'local')
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
      // R-set is confirmed caught up (P4). This fresh winner RAISED our shippable
      // high-water (log.append above), so any prior shed-confirmation was earned against
      // a LOWER mark — invalidate them (`shedReady.delete`) so EVERY R-set member must
      // re-confirm against the new mark before we drop our copy. Without this, a member
      // confirmed earlier (and reused as-is) could let us shed before it holds this
      // record → under-replication / loss if the lone acquirer then fails (the P4
      // "no under-replication window" invariant). The replicateTo above only reaches a
      // REACHABLE R-set; the unreachable owner (the reason we fell back to a local commit)
      // is exactly the member that must re-confirm.
      if (!rset.includes(me!)) {
        orphans.add(p)
        shedReady.delete(p)
      }
    } else mesh.broadcast(change)
  }

  //! commitForwarded: apply a forwarded write so the sink commits it as ours; committingForward stops a re-forward.
  // A peer forwarded a write for a partition we own. Apply it to our proxy as a
  // local write (NOT guarded by `applying`) so the write-capture sink above runs
  // and commits it under our provenance — turning the forwarder's optimistic
  // write into our authoritative, sequenced one. `committingForward` tells the
  // sink to commit it as-is rather than re-evaluate ownership (no re-forward → no
  // ping-pong while ring views are still settling).
  const commitForwarded = (record: ChangeRecord): WriteOutcome | undefined => {
    committingForward = true
    lastCommit = undefined
    try {
      applyRecord(res, record)
    } finally {
      committingForward = false
    }
    return lastCommit // {committed, seq, epoch} from commitLocal; undefined ⇒ no-op apply (value already present) ⇒ idempotently committed
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
    //! writes: the confirm-write lifecycle ViewProxy — built lazily on first access (so an un-introspected node never allocates the ring), then armed for the lifetime of the instance (bounded, off the steady path).
    get writes() {
      return (writesLog ??= makeWritesLog()).proxy
    },
  }

  //! writeWithConfirm: run a default write, returning a confirmation per its `confirm` tier — fire-and-forget (default), 'accepted' (local apply), 'committed' (owner-sequenced), or 'replicated' (W of the R-set).
  // The confirm surface (DECISIONS Z — tiered write guarantees). A bare write (no `confirm`)
  // is fire-and-forget — zero tracking, the steady hot path; `await` resolves on the next
  // microtask with nothing meaningful. 'accepted' resolves once the value is applied on THIS
  // node (the synchronous doWrite) — a read-your-write-on-this-node ack, NOT a durability
  // claim. 'committed'/'replicated'/'persisted' claim confirmHook so the sink reports the write's
  // terminal outcome; all share PHASE 1 (committed = the owner sequenced + logged it, with its
  // origin + seq). 'replicated' adds PHASE 2 — probe the R-set for (origin,seq) and resolve at W
  // HOLDERS. 'persisted' is PHASE 2 against the DURABLE high-water — W of the R-set having
  // RESOLVED storage.append for (origin,seq) (its strength = the seam's: page-cache for the
  // built-in fileStorage, power-loss-safe for an fsync'd one); requires a storage seam. Resolve
  // {tier,key,seq,epoch,origin} (committed = SEQUENCED, not necessarily the LWW winner — a
  // higher-seq concurrent write can still supersede); reject {requestedTier,reachedTier,reason,
  // localCommit} on withheld / timeout / quorum — carrying localCommit when a never-drop fallback
  // committed under our provenance (durable, just owner-unconfirmed) so a retry isn't blind.
  const writeWithConfirm = (chg: any, doWrite: () => void): unknown => {
    const tier = chg && typeof chg === 'object' ? chg.confirm : undefined
    if (!tier) return doWrite() // fire-and-forget (the default — no confirmation, zero overhead)
    const key = norm(chg?.at ?? chg?.key)
    const keyStr = key.join('.') // dotted path for the cluster.writes ticker (gated — undefined unless someone introspected it)
    if (tier === 'accepted') {
      const wid = writesLog?.onStart('accepted', keyStr)
      doWrite()
      if (wid !== undefined) writesLog!.onSettle(wid, 'confirmed', { reachedTier: 'accepted' }) // local apply — latency ≈ 0
      return { tier: 'accepted', key } // applied on this node now (NOT a durability/cluster claim)
    }
    if (tier !== 'committed' && tier !== 'replicated' && tier !== 'persisted') throw new Error(`fero: unknown confirm tier "${tier}" (expected 'accepted' | 'committed' | 'replicated' | 'persisted')`)
    // persisted needs somewhere to persist: with no storage seam its durability high-water never
    // advances, so the probe could only ever time out. Fail FAST + clearly instead. (A persisted
    // cluster needs storage on the holders; this guards the common holder/single-node path.)
    if (tier === 'persisted' && !storage) throw new Error("fero: confirm:'persisted' requires a storage seam (none configured) — use 'replicated' for an in-memory W-quorum")
    const replTimeout = typeof chg?.timeout === 'number' ? chg.timeout : 5000
    const wid = writesLog?.onStart(tier, keyStr) // cluster.writes: a `pending` record now; settled in win/fail with the measured latency (gated — undefined unless introspected)
    let done = false // the whole confirm settled
    let phase1 = false // committed point reached (or rejected) — disarms the safety timer; phase 2 (replicated probe) may still run
    let safety: ReturnType<typeof setTimeout> | undefined
    let resolveP!: (v: unknown) => void
    let rejectP!: (e: unknown) => void
    const promise = new Promise((res, rej) => {
      resolveP = res
      rejectP = rej
    })
    const win = (o: WriteOutcome, reached: string) => {
      if (done) return
      done = true
      if (safety) clearTimeout(safety)
      if (wid !== undefined) writesLog!.onSettle(wid, 'confirmed', { reachedTier: reached, seq: o.seq, epoch: o.epoch, origin: o.origin })
      // origin + seq + epoch are the committed record's FULL LWW coordinates — committed means
      // SEQUENCED, not necessarily WON, so a caller can watch for a (epoch,seq,origin)-dominating
      // later write superseding theirs. origin is the owner's provenance (this node for an owned
      // write, the owner's uuid for a forwarded/client write — carried back on the WRITE-ACK).
      resolveP({ tier: reached, key, seq: o.seq, epoch: o.epoch, origin: o.origin })
    }
    const fail = (o: WriteOutcome) => {
      if (done) return
      done = true
      if (safety) clearTimeout(safety)
      const quorum = o.reason === 'quorum' // phase-2 miss: committed but not replicated to W
      const reachedTier = quorum ? 'committed' : o.seq !== undefined ? 'committed-local' : 'none' // committed-local: a never-drop fallback committed under our provenance (durable, owner-unconfirmed)
      const reason = o.reason ?? 'unconfirmed'
      if (wid !== undefined) writesLog!.onSettle(wid, 'rejected', { reachedTier, reason, seq: o.seq, epoch: o.epoch, origin: o.origin })
      rejectP(
        Object.assign(new Error(`fero: write not ${quorum ? 'replicated to W' : 'committed'} (${reason})`), {
          requestedTier: tier,
          reachedTier,
          reason,
          localCommit: o.seq !== undefined ? { seq: o.seq, epoch: o.epoch, origin: o.origin } : null, // its full LWW coordinates so a retry can detect its own committed-but-unconfirmed write
        }),
      )
    }
    confirmHook = (o) => {
      phase1 = true
      if (safety) {
        clearTimeout(safety)
        safety = undefined
      }
      if (!o.committed) return fail(o) // withheld / never-drop timeout — never reached the committed bar
      if (tier === 'committed') return win(o, 'committed')
      const part = String(key[0])
      const quorumFail = () => fail({ committed: false, seq: o.seq, epoch: o.epoch, origin: o.origin, reason: 'quorum' })
      if (tier === 'replicated')
        // PHASE 2 (replicated) — the owner sequenced it (origin, seq); probe the R-set for W HOLDERS
        return void probeReplicated(part, o.origin!, o.seq!, (ok) => (ok ? win(o, 'replicated') : quorumFail()), replTimeout)
      // PHASE 2 (persisted) — W of the R-set must have DURABLY appended it. If WE hold the
      // partition, wait for OUR OWN append to resolve first (then we count toward W), then
      // durable-probe the rest; if we don't hold it, probe the whole R-set (owner included).
      const startProbe = () => probeReplicated(part, o.origin!, o.seq!, (ok) => (ok ? win(o, 'persisted') : quorumFail()), replTimeout, true)
      if (holds(part)) awaitLocalPersist(seenKey(o.origin!, part), o.seq!, replTimeout, startProbe, quorumFail)
      else startProbe()
    }
    try {
      doWrite()
    } finally {
      confirmHook = undefined // claimed (and cleared) by the sink synchronously; clear here too in case no sink fire occurred
    }
    // An owned write reaches phase 1 synchronously inside doWrite; a forward reaches it via
    // its ACK (or the transport's own callTimeout). The safety timer covers a path that
    // reaches NO confirm point — e.g. an offline client that only buffered the write (it
    // stays buffered for the flush sweep; the await just stops waiting and rejects 'timeout').
    if (!phase1) {
      safety = setTimeout(() => fail({ committed: false, reason: 'timeout' }), replTimeout)
      safety.unref?.()
    }
    return promise
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
    update: (chg, c) => writeWithConfirm(chg, () => setPath(c.data, norm(chg?.key), chg?.value)),
    insert: (chg, c) => writeWithConfirm(chg, () => setPath(c.data, norm(chg?.at ?? chg?.key), chg?.value)),
    remove: (chg, c) => writeWithConfirm(chg, () => delPath(c.data, norm(chg?.key))),
  }
  //! __inspect: gated L4 pull method — returns this node's InspectSnapshot to a remote observer (registered only when observe is on).
  // Recognized by exact name on the existing CALL path (no new wire verb): an observer's
  // mesh.call('__inspect', …) routes here → serveCall → invoke → snapshot(). A user method
  // of the same name still overrides it (the {...defaults, ...methods} merge below). When
  // observe is off it's simply absent, so a remote __inspect call rejects (unknown method)
  // — that absence IS the gate.
  if (observeOn) defaults.__inspect = (arg) => snapshot(arg as { sample?: string[] } | undefined)
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
  const dispatch = makeDispatch({ allMethods, defaults, context, mesh, me, scoped, R, viewSize, holds, data, clientSubs, invoke, fold, onObserve: observeOn ? buildObserve : undefined })

  //! Build the L4 pull snapshot now that all replication state + dispatch.servedCount exist; exposed via [diagnostics] (always) + __inspect (gated).
  // Assigned to the forward-declared `snapshot` (so defaults.__inspect's closure resolves
  // it). A pure read closure — reads seen/versions/log/mesh BY REFERENCE, materializing the
  // object only when called (per observe poll), so it adds nothing to the write/replicate
  // hot path. Always built (a harmless unused closure when observe is off).
  snapshot = makeSnapshot({
    name,
    cluster,
    viewHistory: () => viewMgr?.history() ?? [],
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
      void writeHost // retain the sink host until teardown
      destroyed = true // gate the write-capture sink: a late `r.data.x = y` must not commit, bump the clock, or fsync to the WAL
      storageUnsub?.() // detach the WAL append hook (a gated sink can't append, but other log writers — e.g. a stray applyInbound — must not persist either)
      if (aeTimer) clearInterval(aeTimer)
      if (compactTimer) clearInterval(compactTimer)
      if (clientFlushTimer) clearInterval(clientFlushTimer)
      viewMgr?.destroy()
      for (const unsub of clientSubs) unsub()
      mesh.destroy()
      observe = undefined // drop the push-hook gate + its ring-buffer proxy (any served observe sub is reaped via the mesh teardown above)
    },
    //! [diagnostics]: Symbol-keyed internals seam (off the public API) — pull snapshot + served-sub count + drop/isolate/heal fault injection.
    // Internals seam (Symbol-keyed, off the typed/enumerable public API): observability +
    // fault-injection for tests and power users. `snapshot()` is the L4 pull — this node's full
    // InspectSnapshot (the in-process source the observer bridge reads directly for harness war
    // games; ALWAYS available, unlike the gated wire-reachable __inspect method). `servedSubscriptions`
    // is the count of live subscriptions this node serves (asserts the reap of a dropped peer);
    // `drop` abruptly closes a peer's connection (no UNSUBSCRIBE — the way a real network drop looks)
    // to exercise that reap; `isolate`/`heal` are the reversible partition primitive the chaos harness
    // uses (isolate both sides for a true bidirectional cut that later heals and reconverges — see Peers.isolate).
    [diagnostics]: {
      snapshot,
      servedSubscriptions: dispatch.servedCount,
      //! observing(): is the push-hook armed (≥1 subscriber attached)? The leak-guard test asserts this returns to false after an ungraceful drop.
      observing: () => observe !== undefined,
      //! observe(onRecord): in-process provenance stream (harness war games + the demo) — attach a sink directly; the returned closer (idempotent) detaches + disarms on the last detach.
      observe: (onRecord: (r: ChangeRecord) => void) => {
        const o = buildObserve()
        // `data` holds the FunctionSink only via the anchor's lifetime (no public detach), so a
        // closed observer's sink can keep firing while OTHER subscribers hold the gate armed —
        // gate delivery on `active` for a deterministic logical detach (GC reclaims the rest).
        let active = true
        let host: unknown = o.proxy.connect({}, (r: ChangeRecord) => {
          if (active) onRecord(r)
        })
        return () => {
          if (!active) return // idempotent — o.close() is too, but don't even re-enter it
          active = false
          host = undefined // drop the sink anchor so the FunctionSink can GC
          o.close()
        }
      },
      drop: (address: string) => mesh.drop(address),
      isolate: (address: string) => mesh.isolate(address),
      heal: (address: string) => mesh.heal(address),
      //! confirms(): in-flight confirm:'replicated' bookkeeping — {tally} = writer-side W-quorum probes awaiting acks, {held} = replica-side probes held until caught up. Both must drain to 0 (no leak after a partition/heal).
      confirms: () => ({ tally: replTally.size, held: pendingProbes.size }),
      //! compact(): run a log-compaction pass NOW (the production cadence is the unref'd compactTimer); returns records dropped. Lets tests drive it deterministically.
      compact: () => log.compact(),
      //! logSize(): live record count across all partition segments — asserts compaction actually shrank the log.
      logSize: () => log.size,
    },
  } as Fero
}

//! diagnostics: the Symbol key for the internals handle, kept off the typed public surface and out of Object.keys.
// Symbol-keyed internals handle on a returned fero() instance (`instance[diagnostics]`): kept OFF
// the typed public surface (data/methods/cluster/destroy) and out of Object.keys.
export const diagnostics = Symbol('fero.diagnostics')
