//! ── kernel/node — the deterministic core: step(event) → effects ──────────────
// This file is v3's answer to v2's 1604-line fero() closure. All protocol state
// is explicit fields on a class; the ONLY way the world moves it is
// node.step(event) (a single fail-closed dispatch site); the ONLY way it moves
// the world is the typed EffectSink. No timers, no sockets, no Date.now, no
// Math.random (kernel/purity.test.ts enforces it) — which is why the same bytes
// run under seeded simulation (sim/) and real TCP (shell/) unchanged, and why
// every distributed regression is a reproducible seed instead of a wall-clock
// race.
//
// Scope by milestone: M0 broadcast + dedup + LWW, M1 digest anti-entropy +
// heartbeat floor, M2 membership (committed views, ballots, the write-gate),
// M3 the write pipeline (owner routing via the view-derived ring, forwarded
// attempts, cid dedup, typed NACKs — kernel/write.ts). Still ahead: storage/
// durability (M4), the public api layer (M5), scoped replication (M6).
// Per-origin seqs are LAMPORT stamps, NOT contiguous — there is deliberately no
// hold-back and no reorder tolerance: FIFO links are a PROTOCOL REQUIREMENT,
// provided by TCP and enforced in sim. Streams are per-origin descriptor
// objects (not v2's four parallel string-keyed maps).
//
// The write path IS a function: a 'write' event enters ingest exactly like an
// inbound record does — apply is a downstream EFFECT, so re-entrant capture
// (v2's applying/committingForward/discarding flag family) has no place to
// exist. That whole guard menagerie is deleted by construction, not by care.

import { Framer, FrameError, VERB, encodeControl, encodeRuns, type AttemptRun, type Frame } from './codec.ts'
import { Link, LS, dialedByLower } from './link.ts'
import { JK, Journal } from './journal.ts'
import { Membership } from './membership.ts'
import { Writes } from './write.ts'
import { Streams } from './streams.ts'
import { Confirm } from './confirm.ts'
import { Scope, SCOPE } from './scope.ts'
import { diagHello, onDiagQ } from './diag.ts'
import { maybeCompact } from './log.ts'
import { tuneOf, MAX_REDIALS, LAMPORT_LEASE, SNAPSHOT_AT, type Tune } from './tune.ts'
import { REC, TAG, partitionOf, type Env, type Event, type Rec } from './env.ts'

//! the three node-level defaults live in kernel/tune.ts (it is imported here, so defining them here
// would be an import cycle); re-exported under their old names for the tests and tools that import them
export { MAX_REDIALS, LAMPORT_LEASE, SNAPSHOT_AT } from './tune.ts'

//! NodeOpts: explicit boot facts — no config-shape sniffing (v2's hasPeers heuristic is banned by plan §9).
export interface NodeOpts {
  uuid: string
  //! name (v4.1): the RESOURCE this node replicates, echoed in HELLO. Admission previously checked
  // only uuid shape/dup/self — a connection to a port serving a DIFFERENT fero resource was fully
  // admitted, and digest-on-admit silently cross-replicated two unrelated resources' logs (a durable
  // data merge as the default misdial outcome). When BOTH sides declare a name and they differ, the
  // link refuses loudly (dead + noRedial, JK.nameReject). Absent = legacy/no check (sim harnesses and
  // pre-v4.1 peers are wire-compatible; trajectories without it stay byte-identical).
  name?: string
  listen?: string        // my dialable address, gossiped in HELLO
  hosts?: string[]       // static discovery targets to dial on start
  incarnation?: number   // bumped per restart (M2 fences flappers with it; carried in HELLO from day 0)
  heartbeatMs?: number   // 0 = off (EXPLICIT protocol mode, not a magic duration)
  redialMs?: number      // backoff base; cap = 32x base
  journalCap?: number    // diagnostics ring size — captures that want full-history time-travel raise it
  //! durable (M4b): EXPLICIT protocol mode like heartbeatMs — when true, every committed/ingested run
  // is WAL'd via sink.persist and the boot record is maintained via sink.boot. Off (the default, and
  // the sweep mode) emits ZERO storage effects: trajectories stay byte-identical with M0-M3.
  durable?: boolean
  //! boot record (plan §5 boot modes): the DURABLE facts a restart trusts — the restored committed view
  // (a node booted with epoch > 0 is REJOINING: read-only until a committed view ≥ this epoch is
  // confirmed live), the Lamport floor, and the spent ballot identity (votedFor durability is what makes
  // a crash inside one ballot round unable to double-vote — the M2 debt, closed here).
  boot?: { epoch: number; members: [string, string][]; lamport?: number; votedFor?: { e: number; p: string; h: string }; heldPartitions?: string[]; dirtyParts?: string[] }
  //! client (M5b): EXPLICIT role mode — a SPOKE, never a view member. A client dials its hosts, keeps
  // exactly ONE primary link (the only link it digests — the single-feeder ordering guarantee), folds
  // the same replication stream as everyone else, and issues writes as ae=0 attempts relayed by the
  // primary (plan §5 client writes: a client never stamps provenance; the FIRST server re-stamps at
  // relay time). It never proposes, votes, JOIN-knocks, or counts toward genesis.
  client?: boolean
  //! replicas (M6): EXPLICIT protocol mode like durable/client — scoped replication. Unset/0 = the
  // R=∞ mode: every member holds every partition and the scoping machinery is provably inert (the
  // sweep mode; trajectories stay byte-identical with M0-M5). Set (≥1) = each partition lives on
  // exactly R holders (ring.holdersOf, holder[0] = the owner — single-writer untouched); replication
  // fans out to holders only, non-holders shed under the keep-until-confirmed protocol (plan §5).
  // Must be set identically on every member — like heartbeatMs, cluster config is the deployer's
  // contract (the exactly-R sim monitor catches drift in test).
  replicas?: number
  //! diag (M7, DESIGN-M7 §1): the authenticated diagnostics channel's allowlist — name → opaque bearer
  // token (names are audit identities and ride the journal; tokens never do). Absent/empty = the DIAG
  // channel is DEAD: every r:2 HELLO is denied (fail closed, like durable/client/replicas — absent =
  // mode off). Object values ({token, scopes}) are reserved post-1.0. The token crosses cleartext —
  // run DIAG on trusted networks or a tunnel (plan §12 posture, stated out loud).
  diag?: { allow: Record<string, string> }
  //! validate (relay validation, 2026-09-05): the embedder's per-record admission predicate for RELAYED
  // client writes — the api hands seams.validation down so the relay ingress (write.ts onWrite, ae 0)
  // runs the SAME check this server runs on its own issues: relay time is an issuer boundary, and an
  // issuer validates before it issues. A pure function of the record (it runs inside step(); no I/O);
  // a refusal WNACKs {r:'invalid', m: reason} back to the client and never enters the pipeline. Absent
  // = every relayed record admitted (the prior behavior; trajectories stay byte-identical). Forwarded
  // (ae > 0) peer attempts are NOT re-validated: the issuing server already ran its validator, and
  // peers are trusted at this layer — same code, same config (the deployer's contract, like replicas).
  validate?: (rec: Rec) => true | string
  //! tune (the tune table, kernel/tune.ts): per-node overrides of the kernel's bounds and tick counts.
  // Absent = the defaults, which equal the old constants (trajectories stay byte-identical). Validated
  // once in the constructor and frozen: an unknown row or a non-integer or negative value throws.
  tune?: Partial<Tune>
}

export class Node {
  //! tune — the frozen table every read site consults (`node.tune.<row>`). Assigned FIRST in the
  // constructor, before anything that could read a row; never read from a field initializer.
  readonly tune: Readonly<Tune>
  readonly uuid: string
  //! name — the resource identity this node replicates; rides HELLO so a misdial onto another
  // resource's port refuses instead of silently merging logs (see NodeOpts.name). Optional: absent
  // (sim harness, embedders) disables the check and keeps the HELLO body byte-identical with v4.0.
  readonly name?: string
  //! listen — my dialable address, gossiped in HELLO. Assignable (V4-3): a shell that binds port 0 writes
  // the OS-chosen address here inside its listen callback — before the start stimulus and before any
  // accepted socket can HELLO — and the kernel reads it only at send/propose time. Assignment invalidates
  // the cached hosts (own listen is excluded from the dial set).
  #listen = ''
  get listen(): string { return this.#listen }
  set listen(v: string) { this.#listen = v; this.#hostsCache = null }
  readonly incarnation: number
  //! origin — THE PROVENANCE LANE this life stamps under: the bare uuid for incarnation 1, uuid~inc
  // for reborn lives (so first lives — and every pre-M4 trajectory — are byte-identical on the wire).
  // The lane is what makes crash recovery structurally sound: a previous life's stream becomes an
  // IMMUTABLE FOREIGN stream the reborn re-syncs via ordinary suffix anti-entropy (its chain-truncated
  // replay left a clean tail), instead of an unhealable interior hole inside one shared log — one log
  // cannot serve two lives once the clock lease jumps past the lost records. The Lamport CEILING keeps
  // new-lane stamps LWW-dominant over everything the old lane wrote ("incarnation fences flappers and
  // stops dead-origin debris" — plan §5, made concrete). Old lanes are debris compaction sweeps (M4d).
  readonly origin: string
  journal: Journal
  //! links by env-minted id; byUuid enforces one-logical-link-per-pair (kernel/link.ts keeper rule)
  links = new Map<number, Link>()
  byUuid = new Map<string, number>()
  //! replication state — explicit fields, not closure captures.
  // `seq` IS the Lamport clock: it merges up on every inbound record and
  // increments on every local write, so a local write is always causally newest
  // (v2 DECISIONS A, kept). Convergence then follows from per-cell LWW below.
  seq = 0
  epoch = 0
  //! membership (M2): committed views, ballots, the write-gate. The data plane below stays open —
  // membership gates COMMITS and majority math, never replication (an evicted node still converges).
  membership: Membership
  //! writes (M3): THE single write ingress — attempts, cid dedup, owner routing/forwarding, the ONE
  // bounded pending queue. Local 'write' events, forwarded WRITE frames, and inbound RECORDS all
  // enter the system through this object (kernel/write.ts is the stamp-site module).
  writes = new Writes()
  //! confirm (M4c): the guarantee ladder — probes over the watermark evidence (kernel/confirm.ts)
  confirm = new Confirm()
  //! scope (M6): the per-partition scoped-replication state machine (kernel/scope.ts) — constructed
  // only on scoped nodes, consulted only when armed; null at R=∞ (structurally unreachable unscoped).
  scope: Scope | null = null
  //! streams (M4a): per-origin descriptors carrying the watermark ladder {applied, shippable, durable}
  // (kernel/streams.ts). Seqs are LAMPORT stamps — monotone per origin but NOT contiguous (the clock
  // merges up on receipt), so dedup on `applied` is gap-tolerant: over a FIFO link from the single
  // broadcaster, any arrival ≤ applied is a genuine duplicate and any arrival > applied is new (the
  // plan §5 ordering contract, stated here instead of living as v2 folklore).
  streams = new Streams()
  //! versions: per-cell LWW stamps, lexicographic (epoch, seq, origin) — the ONE conflict-resolution rule (plan §5).
  // Cells are full key paths (field-granular); a remove leaves its stamp as a
  // tombstone so a slower concurrent update cannot resurrect the value. Tombstone
  // GC ties to compaction at M4 — bounded growth is a KNOWN M0 debt, journal-visible in size.
  versions = new Map<string, { epoch: number; seq: number; origin: string }>()
  //! per-origin record logs: the retransmit buffer (plan §5: "the log IS the retransmit buffer").
  // EVERY arrived record is stored (LWW losers included — a loser here may be the
  // only copy a lagging peer ever gets offered, and the election re-runs
  // identically everywhere), seq-ascending per origin because ingest is monotone.
  // Anti-entropy is digest-gated: on admit (and after a drop-under-backpressure)
  // peers exchange {origin: highestHeldSeq} digests and ship ONLY the missing
  // suffixes. Suffix-only healing is sound because loss is always TAIL loss —
  // FIFO links cannot create interior gaps; a died link loses a suffix, a
  // dropped-oldest queue loses a suffix of what that link would have sent.
  // This closes the dial-race loss window the adversarial review proved (a write
  // flushed only on the dup-loser link died with it) and removes the form-first
  // constraint: whatever a doomed link swallowed, the digest exchange on the
  // surviving link re-ships. Unbounded in M0; M4's compaction bounds it.
  // Entries retain the ATTEMPT identity (iss/cid) of committed forwarded writes
  // so anti-entropy re-ships it — a healed or future owner rebuilds its dedup
  // window from the log stream itself (M3's ownership-move exactly-once story).
  logs = new Map<string, { rec: Rec; seq: number; epoch: number; iss?: string; cid?: number; pp?: number }[]>()
  //! M6 pp (the floor law): the last seq this life stamped per partition — the sub-stream
  // predecessor the NEXT own-lane stamp carries. Fed on every scoped commit (epoch 0 included) and
  // NEVER cleared by shed (a shed-then-reassigned same-life owner must not re-stamp pp=0 over its
  // own shed history); restarts rebirth the origin lane, so a fresh map is truthful. Memory-only.
  lastStamp = new Map<string, number>()
  //! M0 downstream state: a flat path→value map + an order-insensitive rolling hash.
  // The api layer binds a $() proxy to sink.apply() later (M5); the kernel keeps
  // this mirror so sim monitors and the replay/state-hash check (plan §3.1) can
  // interrogate state without reaching through a proxy.
  state = new Map<string, unknown>()
  #entryHash = new Map<string, number>()
  #hash = 0
  //! timers — kernel-minted ids; fired ids not in #timers are stale (cancel raced the fire) and ignored
  #timerSeq = 0
  #timers = new Map<number, { tag: number; to?: string }>()
  //! gaveUp distinguishes "parked after the final attempt FAILED" from "the final attempt is still
  // pending" — tries increments at ARM time, so tries alone cannot tell them apart, and a revival
  // during the pending window would orphan the live timer into a second concurrent dial chain
  // (adversarial-review finding: forked chains, doubled dial traffic, starved giveUp).
  //! parked (V4-3): a forgotten DYNAMIC target that a live link (or an in-flight dial) still names —
  // kept only so that link's eventual linkDown ends the chain instead of starting one; nothing dials,
  // revives, or counts a parked target, and #redial drops the entry the moment it is consulted
  #backoff = new Map<string, { ms: number; tries: number; gaveUp?: boolean; parked?: boolean }>()
  //! highest incarnation ever identified per peer uuid — a HELLO above it means the peer was REBORN,
  // and every evidence mark its previous life announced is void (confirm.forget; see that banner).
  #peerInc = new Map<string, number>()
  #hbTimer = -1
  destroyed = false
  env: Env
  #opts: NodeOpts

  //! M4b storage plumbing: WAL batches in flight (batch → per-origin max seq, resolved into the durable
  // watermark on the 'persisted' echo), the per-origin WAL CHAIN TAIL (each row records the seq its
  // origin's chain stood at — replay's interior-hole detector), the dead-WAL latch (a persistFail is
  // terminal: fsyncgate — a store that failed once may have lied about anything since), and the
  // boot-time replay framer. All empty/idle when durable is off.
  #batchSeq = 0
  #inflight = new Map<number, Map<string, number>>()
  //! M6 armed-durable bookkeeping (all empty unscoped): per-batch (origin, partition) covers for the
  // durable-floor advance; the DIRTY set — partitions holding a memory-only splice (counter per
  // partition: a re-splice between a snapshot's build and its echo must survive the echo's clear);
  // the per-snapshot metadata {floors at build, dirty counters at build} its echo commits.
  #inflightParts = new Map<number, Map<string, Map<string, number>>>()
  #dirty = new Map<string, number>()
  #snapMeta = new Map<number, { floors: Map<string, Map<string, number>>; clears: Map<string, number> }>()
  //! boot-restored M6 facts (C10): the foldable set of the previous life (held ∪ orphaned — null =
  // record absent / unscoped), the FROZEN half (finding 48: restored orphans re-enter only through
  // the latch, even when the restored ring re-assigns them), and the partitions whose replay floors
  // must NOT rebuild (see BootRecord.dirtyParts).
  bootHeld: Set<string> | null = null
  bootOrphans: Set<string> | null = null
  bootDirty = new Set<string>()
  bootAt0 = true
  get bornAt0(): boolean { return this.bootAt0 }
  set bornAt0(v: boolean) { this.bootAt0 = v }
  walTail = new Map<string, number>()
  #walDead = false
  #seqCeiling = 0
  #replayer: Framer | null = null
  #walRows = 0 // rows appended since the last snapshot — the SNAPSHOT_AT arming counter
  //! tainted — the restore was CONDEMNED: replay found an interior chain hole, which only a disk that
  // resolved-then-lost a row can produce (honest crashes tear TAILS: the shell's ordered io-queue and
  // the sim's FIFO fsync clock make resolved-past-a-hole unwritable). Fsyncgate says a liar's rows are
  // not evidence — keeping the prefix could resurrect cells whose removes were compacted away
  // cluster-wide on the strength of this disk's own durable claims (the seed-27 divergence). The fold
  // resets to empty, remaining replay rows are ignored, the WAL swaps clean, and the cluster re-teaches
  // everything — the proven-convergent wiped-disk path. Boot facts (identity, epoch, clock ceiling,
  // ballot) are UNTOUCHED: they live in the boot record, which was never contradicted.
  tainted = false

  constructor(opts: NodeOpts, env: Env) {
    this.tune = tuneOf(opts.tune) // first: validated and frozen before any row can be read
    this.env = env
    this.journal = new Journal(opts.journalCap)
    this.uuid = opts.uuid
    this.name = opts.name
    this.listen = opts.listen ?? ''
    this.incarnation = opts.incarnation ?? 1
    this.origin = this.incarnation > 1 ? `${this.uuid}~${this.incarnation}` : this.uuid
    this.membership = new Membership(opts.boot)
    this.epoch = this.membership.view.epoch // a restored node stamps at its restored epoch, never below it
    //! bornAt0 — this LIFE started at open genesis (not a boot restore): the one licence for the
    // arming floor-truing (scope.rescope) — its lanes at the arming instant are epoch-0 full
    // broadcast, complete by construction. A restored life's lanes may hold lawful pp-gaps.
    this.bornAt0 = this.epoch === 0
    //! the boot record's foldable set = held ∪ orphaned (both restore data); the orphan half ALSO
    // restores its frozen classification (finding 48 — rescope must not silently un-freeze it)
    if (opts.boot?.heldPartitions || opts.boot?.orphanParts)
      this.bootHeld = new Set([...(opts.boot.heldPartitions ?? []), ...(opts.boot.orphanParts ?? [])])
    if (opts.boot?.orphanParts) this.bootOrphans = new Set(opts.boot.orphanParts)
    if (opts.boot?.dirtyParts) { this.bootDirty = new Set(opts.boot.dirtyParts); for (const p of this.bootDirty) this.#dirty.set(p, 0) }
    //! the floor SEED (the pp chain-rebuild's base — see BootRecord.floors): restored BEFORE replay
    // so each row's chain check advances from the last durably-recorded floor instead of collapsing
    // to 0 at the first compacted/pre-pp gap. Dirty partitions stay unseeded (their floors would
    // overclaim the lost splice — the honest-low rule, unchanged).
    if (opts.boot?.floors)
      for (const [origin, parts] of Object.entries(opts.boot.floors))
        for (const [p, sd] of Object.entries(parts)) {
          if (this.bootDirty.has(p)) continue
          const pe = this.streams.for(origin).part(p)
          pe.s = sd[0]
          pe.d = sd[1]
        }
    if ((opts.replicas ?? 0) > 0) this.scope = new Scope() // (this.#opts assigns below — read opts directly)
    //! the Lamport floor from the boot record: even if the WAL tail was torn, the clock never restarts
    // below the last durably-recorded stamp (seq reuse under one origin would collide provenance)
    this.seq = opts.boot?.lamport ?? 0
    this.#opts = opts
  }

  //! durable — the M4 storage mode (explicit, like heartbeats). Off ⇒ zero storage effects.
  get durable(): boolean { return this.#opts.durable === true }

  //! client — the M5b role mode (see NodeOpts.client). Off ⇒ zero behavioural difference.
  get client(): boolean { return this.#opts.client === true }

  //! replicas — the M6 scoped-replication mode (see NodeOpts.replicas). 0 ⇒ unscoped (R=∞), the
  // machinery is inert; scoped() is the one branch guard every M6 code path hangs off.
  get replicas(): number { return this.#opts.replicas ?? 0 }
  get scoped(): boolean { return (this.#opts.replicas ?? 0) > 0 }

  //! diagAllow — the M7 DIAG allowlist (see NodeOpts.diag). Absent/empty ⇒ the channel is dead: every
  // r:2 HELLO is denied (fail closed, the durable/client/replicas idiom for absent modes).
  get diagAllow(): Record<string, string> | undefined { return this.#opts.diag?.allow }

  //! validate — the relay-ingress admission predicate (see NodeOpts.validate). Absent ⇒ every relayed
  // record is admitted; onWrite's relay branch pays one undefined-check per FRAME, nothing per record.
  get validate(): ((rec: Rec) => true | string) | undefined { return this.#opts.validate }

  //! armed — scoping is LIVE: scoped ∧ a committed view exists. Open genesis (epoch 0) is always
  // unscoped — there is no committed ring to scope against, every node owns its own writes, and the
  // epoch-0 fast path must stay byte-identical (DESIGN-M6 rule 3). Every scoped branch in the
  // replication plane guards on THIS, never on `scoped` alone.
  get armed(): boolean { return this.scoped && this.epoch > 0 }

  //! spliced — a dual-fence splice landed for partition p (armed ingest only). Durable bookkeeping:
  // the splice is memory-only (an interior row would walk walTail backwards and condemn the chain on
  // replay), so the partition goes DIRTY and the snapshot swap is armed — the next tick's whole-WAL
  // swap captures the lane in order. The FIRST transition to dirty persists the boot record
  // synchronously: a crash before the swap must restore with this partition's floors zeroed
  // (BootRecord.dirtyParts), or replay's row-max rebuild would attest coverage of the lost interior.
  spliced(p: string) {
    if (!this.durable) return
    const n = this.#dirty.get(p)
    this.#dirty.set(p, (n ?? 0) + 1)
    this.#walRows = SNAPSHOT_AT // arm: the next heartbeat tick swaps the WAL
    if (n === undefined) this.persistBoot()
  }

  //! replayHeld — the C10 replay classification: is partition p this life's to fold? The boot record
  // is the data authority for FOREIGN lanes — ring-assigned-but-absent partitions are `out` (window 5:
  // a crash mid-latch leaves staged records inside mixed WAL rows; folding them on the ring's say-so
  // would resurrect a baseless partial span with overclaiming floors — the clean re-acquire is the
  // recovery). OWN-LINEAGE lanes (this uuid, any incarnation) are the one exception (M6-review
  // finding 11): every own-lineage WAL row was stamped by this node's own commit path (single-writer;
  // staged foreign records never ride persistRun), so an acquiring OWNER's mid-latch commits — WACK'd,
  // possibly the ONLY copy at R=1 — are disk truth the boot record lawfully lags (heldList excludes
  // acquiring). Folding them is data-safe in every window: unassigned content re-derives an orphan
  // that freezes, polls, and re-sheds only on fresh coverage proof.
  // A boot record without the field (a pre-scoped life upgrading) folds everything, the old behavior.
  replayHeld(p: string, origin?: string): boolean {
    if (origin !== undefined && (origin === this.uuid || origin.startsWith(this.uuid + '~'))) return true
    return this.bootHeld === null || this.bootHeld.has(p)
  }

  //! primary — the client's ONE feeder link id (null while unconnected). Kernel-internal to the client
  // role; the write drain targets it, digests flow only over it, failover re-elects on its linkDown.
  primary: number | null = null

  //! clientLinks — the admitted CLIENT links this node serves (maintained at HELLO/linkDown). The
  // tap-forward (write.ts inbound) iterates this set — one size check when a node serves no clients,
  // so the member hot path pays nothing (M5b).
  clientLinks = new Set<Link>()
  //! resync (spokes only, 2026-09-06 — DECISIONS V4-5): a spoke's fold is a VIEW of its feeder's, never a
  // source. When the feeder's digest shows a lane tail BELOW ours, the cluster's truth moved under us
  // (records died with a server; a failover landed on a lagging feeder) — the fold resets, an empty r=1
  // digest asks the feeder for everything, and the feeder's r=0 reply (FIFO: after the suffix) completes
  // it: every cell held before that did not come back is removed downstream. `old` = the cells held at
  // the reset. Null when not resyncing. Survives a failover (the new primary's reply completes it).
  resync: { old: Set<string> } | null = null

  //! hosts — the discovery targets: static NodeOpts.hosts ∪ the dynamic set the `discover` event
  // installs (V4-3), deduplicated, minus this node's own listen. Genesis (links ≥ hosts) and the
  // revival loop read it every heartbeat, so it is CACHED — rebuilt only when either set (or the
  // listen) changes; the per-tick readers allocate nothing.
  #dynamic: string[] = []
  #hostsCache: string[] | null = null
  get hosts(): string[] {
    if (this.#hostsCache === null) {
      const out = new Set<string>()
      for (const h of this.#opts.hosts ?? []) if (h !== this.listen) out.add(h)
      for (const h of this.#dynamic) if (h !== this.listen) out.add(h)
      this.#hostsCache = [...out]
    }
    return this.#hostsCache
  }

  //! dialing — is a backoff chain still actively trying this target? Membership holds eviction while
  // true: an un-exhausted dial means reachability is UNKNOWN (e.g. the pending-redial window right
  // after a heal), and evicting then is churn a one-tick wait avoids. Give-up ends the hold.
  dialing(to: string): boolean {
    const b = this.#backoff.get(to)
    return !!b && !b.gaveUp && !b.parked
  }

  //! #revivable — the give-up revival target set: static hosts ∪ committed-view member listens (a
  // joiner learned via a VIEW is as entitled to revival as a configured host — it may OWN partitions).
  #revivable(): Set<string> {
    const targets = new Set(this.hosts)
    for (const [u, listen] of this.membership.view.members) if (u !== this.uuid && listen) targets.add(listen)
    return targets
  }

  //! step — the single dispatch site. Unknown event kinds fail closed (throw): an unrecognised stimulus is a harness bug, never something to guess at.
  step(e: Event) {
    if (this.destroyed) return
    const j = this.journal
    switch (e.kind) {
      case 'start': {
        j.armed && j.emit(JK.start)
        //! M6: a RESTORED armed node classifies its replayed data before the network exists — held vs
        // orphan derives from (boot record ∪ restored ring ∪ the frozen orphanParts half), the C10
        // rule the replay held-gate used
        if (this.armed) this.scope!.rescope(this)
        //! restored dirtyParts arm the snapshot swap immediately (M6-review finding 54): the dirty
        // ledger's only clear site is a snapshot echo, and nothing else would schedule one — the
        // floors stayed pinned at 0 and the ledger persisted forever.
        if (this.durable && this.#dirty.size) this.#walRows = SNAPSHOT_AT
        this.persistBoot() // the incarnation bump is a durable fact from the first instant
        for (const to of this.hosts) {
          j.armed && j.emit(JK.dial, to)
          this.env.sink.connect(to)
        }
        if ((this.#opts.heartbeatMs ?? 0) > 0) this.#armHeartbeat()
        return
      }
      //! discover (V4-3): the dynamic host set, replaced wholesale. ADDED targets dial now unless a live
      // link already covers them (our dialed `to`, or the peer's gossiped listen) or a backoff chain is
      // still actively trying them; the dial registers a tries-0 entry so a park arriving while it is
      // in flight can see it. FORGOTTEN targets: any armed redial timer is CANCELLED (never an orphaned
      // second chain — the V4-3 panel's fork), then the entry is PARKED while a live link or an in-flight
      // dial still names the target (its eventual linkDown must end the chain, not start one) and
      // simply dropped otherwise — nothing can redial an address no timer, link, host, or member names,
      // so #backoff stays bounded. Static hosts and committed members are never forgotten. Live links
      // are never closed here: a peer's departure is a link fact, not a directory fact. A target
      // re-added later clears its park and dials afresh.
      case 'discover': {
        const next = new Set<string>()
        for (const h of e.hosts) if (h && h !== this.listen) next.add(h)
        const prev = new Set(this.#dynamic)
        this.#dynamic = [...next]
        this.#hostsCache = null
        const statics = new Set(this.#opts.hosts ?? [])
        const covered = (to: string): boolean => {
          for (const l of this.links.values()) if (!l.dead && (l.to === to || l.listen === to)) return true
          return false
        }
        for (const to of prev) {
          if (next.has(to) || statics.has(to) || this.membership.view.members.some(([, l]) => l === to)) continue
          for (const [id, m] of this.#timers) if (m.tag === TAG.redial && m.to === to) { this.#timers.delete(id); this.env.sink.cancel(id) }
          if (covered(to) || this.dialing(to)) this.#backoff.set(to, { ms: this.#opts.redialMs ?? 100, tries: MAX_REDIALS, gaveUp: true, parked: true })
          else this.#backoff.delete(to)
        }
        for (const to of next) {
          if (prev.has(to) || statics.has(to)) continue
          if (covered(to)) { this.#backoff.delete(to); continue }
          if (this.dialing(to)) continue
          this.#backoff.set(to, { ms: this.#opts.redialMs ?? 100, tries: 0 }) // a dial in flight — visible to a park
          j.armed && j.emit(JK.dial, to)
          this.env.sink.connect(to)
        }
        return
      }
      //! M4b storage echoes: a WAL batch resolved (advance the durable watermarks it covered) or failed
      // (surfaced alarm — durable simply never advances past the hole; confirm:'persisted' becomes
      // unreachable there, which is the honest answer).
      //! leave (V4-6): the graceful-exit stimulus — membership runs the ballot; sink.left reports the outcome
      case 'leave': {
        this.membership.leave(this)
        return
      }
      case 'persisted': {
        const covered = this.#inflight.get(e.batch)
        if (!covered) return // unknown/duplicate echo — ignored by id, like timers
        this.#inflight.delete(e.batch)
        for (const [origin, maxSeq] of covered) {
          const d = this.streams.for(origin)
          //! armed: the SCALAR durable stays capped at shippable — a snapshot swap captures dual-fence
          // splices whose lane tail exceeds the scalar shippable (splices deliberately never advance
          // it: interior completeness is a per-partition fact). The floors below carry the precise
          // durable claim; the scalar under-reports in the safe direction and the ladder invariant
          // (applied ≥ shippable ≥ durable) holds per instant on every node.
          const cap = this.armed ? Math.min(maxSeq, d.shippable) : maxSeq
          if (cap > d.durable) d.durable = cap
        }
        //! M6 durable floors (armed only): a persistRun batch advances exactly the (origin, partition)
        // floors its rows cover — SKIPPING partitions currently dirty (a memory-only splice means the
        // WAL under-covers below the row max; the snapshot echo below is their only advance site),
        // partitions with no POSSESSION-state scope entry (shed or re-latched while the batch was in
        // flight: get-or-creating the floor here resurrects a ghost {s:0, d>0} durable claim for rows
        // the shed's swap purged — M6-review findings 16/20), and any advance past the possession
        // floor (pe.d ≤ pe.s per instant: durable evidence never exceeds the possession claim).
        const pcov = this.#inflightParts.get(e.batch)
        if (pcov) {
          this.#inflightParts.delete(e.batch)
          for (const [origin, parts] of pcov) {
            const d = this.streams.for(origin)
            for (const [p, maxSeq] of parts) {
              if (this.#dirty.has(p)) continue
              const st = this.scope!.entries.get(p)?.state
              if (st !== SCOPE.held && st !== SCOPE.orphan) continue
              const pe = d.part(p)
              const cap = Math.min(maxSeq, pe.s)
              if (cap > pe.d) pe.d = cap
            }
          }
        }
        //! M6 snapshot echo (armed only): the swap captured the whole fold — every floor advances to
        // its build-time possession value, and build-time dirty entries clear (unless re-spliced since
        // build: the counter moved) with the boot record rewritten to drop them. The same possession-
        // state guard applies: a partition shed (or re-latched) between build and echo takes nothing.
        const snap = this.#snapMeta.get(e.batch)
        if (snap) {
          this.#snapMeta.delete(e.batch)
          for (const [origin, parts] of snap.floors) {
            const d = this.streams.for(origin)
            for (const [p, s] of parts) {
              const st = this.scope!.entries.get(p)?.state
              if (st !== SCOPE.held && st !== SCOPE.orphan) continue
              const pe = d.part(p)
              const cap = Math.min(s, pe.s)
              if (cap > pe.d) pe.d = cap
            }
          }
          let cleared = false
          const sealedNow: string[] = []
          for (const [p, n] of snap.clears) if (this.#dirty.get(p) === n) { this.#dirty.delete(p); cleared = true; sealedNow.push(p) }
          if (cleared) this.persistBoot()
          //! the SEAL (findings 19/37/46): a dirty-clear proves the disk restores this partition's
          // whole base — a pending ACQDONE attestation gate opens now (announce + boot-list re-entry)
          for (const p of sealedNow) this.scope!.sealed(this, p)
        }
        j.armed && j.emit(JK.persisted, e.batch)
        this.confirm.recount(this) // own durable advanced — a persisted probe may now have its quorum
        return
      }
      //! M4c: the guarantee-ladder probes (kernel/confirm.ts) — register may answer synchronously
      case 'confirm': {
        this.confirm.register(this, e.id, e.origin, e.seq, e.level, e.part)
        return
      }
      case 'confirmCancel': {
        this.confirm.cancel(this, e.id)
        return
      }
      //! ── M5c method plane (the routing half; the api host holds the handlers) ──
      //! rpc: the CALLER side ships CALL/SUB/UNSUB on its primary. No live primary ⇒ an immediate
      // failed result — the api's failover policy owns retries (the kernel stays stateless here:
      // it routes frames, it does not track rpc ids).
      case 'rpc': {
        //! route: a named member (M6 `to` — the scoped gather/remote-read fan-out) or the primary (a
        // spoke's default). Unreachable answers locally either way — the api's failover owns retries.
        const id = e.to !== undefined ? (this.byUuid.get(e.to) ?? null) : this.primary
        const link = id !== null ? this.links.get(id) : undefined
        if (!link || link.state !== LS.admitted || link.dead) {
          j.armed && j.emit(JK.rpcFail, e.id, 'unreachable')
          this.env.sink.result(e.id, false, 'unreachable', true) // local=true: never shipped, never executed
          return
        }
        j.armed && j.emit(JK.rpcOut, e.mode, e.id)
        link.ship(encodeControl(e.mode, e.mode === VERB.UNSUB ? { id: e.id } : { id: e.id, m: e.m, a: e.a }), this.env.sink, j)
        return
      }
      //! reply/subOut: the HOST side answers an invoke — framed back down the link it came in on.
      // A dead/gone link is a silent no-op: the caller's own linkDown handling owns that failure.
      case 'reply': {
        const link = this.links.get(e.link)
        if (!link || link.state !== LS.admitted || link.dead) return
        link.ship(encodeControl(VERB.RESULT, { id: e.id, ok: e.ok ? 1 : 0, v: e.value }), this.env.sink, j)
        return
      }
      case 'subOut': {
        const link = this.links.get(e.link)
        if (!link || link.state !== LS.admitted || link.dead) return
        link.ship(encodeControl(VERB.SUBREC, { id: e.id, recs: e.recs }), this.env.sink, j)
        return
      }
      case 'persistFail': {
        //! TERMINAL (the fsyncgate policy): a store that failed one batch may have lied about anything
        // after it — rows persisted past a failure would replay as a chain built on sand. The WAL is
        // dead from here: durable freezes, the alarm is the operator's problem, replication is untouched.
        // FREEZES MEANS FREEZES (M4-review critical, four independent finders): every batch still in
        // flight is voided too — a batch issued before the failure but resolving after it sits PAST the
        // hole on disk, and advancing durable on its echo would hand confirm:'persisted' false evidence
        // for rows a restore will drop at the tear. Clearing #inflight makes the later echoes no-ops.
        this.#inflight.clear()
        this.#walDead = true
        j.armed && j.emit(JK.persistFail, e.batch, e.reason)
        return
      }
      //! M4b replay: WAL bytes re-enter through the SAME ingest (source=replay in kernel/write.ts),
      // original provenance, before the network exists. The boot framer re-slices exactly like a link's.
      case 'replay': {
        this.#replayer ??= new Framer()
        try {
          for (const f of this.#replayer.push(e.bytes)) this.writes.replay(this, f, e.prev ?? 0)
        } catch (err) {
          if (!(err instanceof FrameError)) throw err
          //! a torn WAL tail decodes as a truncated/corrupt frame — surfaced, replay stops at the tear
          j.armed && j.emit(JK.frameDrop, -1, `wal: ${err.message}`)
          this.#replayer = new Framer()
        }
        return
      }
      case 'linkUp': {
        const link = new Link(e.link, e.dialed, e.to)
        this.links.set(e.link, link)
        j.armed && j.emit(JK.linkUp, e.link, e.dialed ? 1 : 0)
        //! both sides open with HELLO — identity first, before anything routes. Clients declare the
        // role (r:1) so the peer excludes them from genesis and feeds them by tap-forward (M5b).
        // `n` (v4.1) declares the RESOURCE, only when configured — absent keys keep the frame
        // byte-identical with v4.0 (the sim's byte-identical sweep contract rides on that).
        link.ship(encodeControl(VERB.HELLO, {
          u: this.uuid, i: this.incarnation, l: this.listen,
          ...(this.client ? { r: 1 } : {}),
          ...(this.name !== undefined ? { n: this.name } : {}),
        }), this.env.sink, j)
        return
      }
      case 'bytesIn': {
        const link = this.links.get(e.link)
        if (!link || link.dead) return // raced close — ids are never reused, so late chunks are safely ignored
        //! the FrameError net covers BOTH framing AND dispatch: decode is LAZY, so a crc-valid frame with a
        // malformed body (bad vt, overrun count, trailing bytes) throws inside #dispatch when a getter first
        // touches it — outside this catch it would crash the node on one hostile frame (adversarial-review
        // critical finding). FrameError → drop the link; any other throw is a real bug and rethrows unmasked.
        try {
          for (const f of link.framer.push(e.bytes)) {
            this.#dispatch(link, f)
            if (link.dead) break
          }
        } catch (err) {
          if (!(err instanceof FrameError)) throw err
          j.armed && j.emit(JK.frameDrop, e.link, err.message)
          link.dead = true
          this.env.sink.close(e.link, 'wire-fault')
          return
        }
        link.flush(this.env.sink, j) // one frame per link per step, even when a chunk carried many inbound frames
        return
      }
      case 'linkDown': {
        const link = this.links.get(e.link)
        j.armed && j.emit(JK.linkDown, e.link, e.reason)
        if (!link) {
          //! a dial that FAILED before linkUp: no link entry exists, but `to` rides on the event — still schedule the redial
          if (e.to) this.#redial(e.to)
          return
        }
        this.links.delete(e.link)
        if (this.byUuid.get(link.uuid) === e.link) this.byUuid.delete(link.uuid)
        this.clientLinks.delete(link)
        //! M6: a dying teacher aborts every latch it was feeding (window 6 — the buffer drops whole,
        // nothing folded, the next handshake round re-offers from a surviving holder)
        if (this.armed && link.uuid) this.scope!.linkDown(this, link.uuid)
        //! client primary failover (M5b): the feeder died — elect the next admitted server, digest it
        // (its suffix ship resumes every origin lane from our announced tails, in order), and re-park
        // the in-flight attempts so the write drain re-targets the new relay NOW, not at RETRY_TICKS.
        if (this.client && this.primary === e.link) {
          this.primary = null
          for (const l of this.links.values())
            if (l.state === LS.admitted && !l.dead) { this.primary = l.id; break }
          if (this.primary !== null) {
            this.#sendDigest(this.links.get(this.primary)!, 1)
            this.writes.repark(this)
          }
        }
        //! BOTH sides redial a lost peer (jittered capped backoff) — the dialer via its target, the
        // acceptor via the peer's gossiped listen. The acceptor-side chain is what arms the eviction
        // dialing-hold symmetrically (review: a 3-tick blip once evicted a live member from the acceptor
        // side, which held no chain) — crossing dials collapse via the one-link-per-pair dedup as usual.
        // Deliberate closes (dup-link/self-reject) never redial: that would just re-create the race.
        const redialTo = link.noRedial ? '' : link.dialed ? link.to ?? '' : link.listen
        if (redialTo) this.#redial(redialTo)
        //! a lost member link can flip the write-gate to minority — journal the transition NOW, not at the next tick
        if (link.state === LS.admitted) this.membership.settle(this)
        return
      }
      case 'pause': {
        const link = this.links.get(e.link)
        if (link) { link.paused = true; j.armed && j.emit(JK.pause, e.link) }
        return
      }
      case 'drain': {
        const link = this.links.get(e.link)
        if (!link) return
        link.drain(this.env.sink, j)
        //! drop-under-backpressure left the peer with a tail hole in our stream — follow the drain with a
        // digest exchange so the loss heals within two round-trips instead of lingering until the next admit
        if (link.droppedWhilePaused && link.state === LS.admitted) {
          link.droppedWhilePaused = false
          this.#sendDigest(link, 1)
        }
        return
      }
      case 'timer': {
        const meta = this.#timers.get(e.id)
        if (!meta) return // cancelled — the raced fire is ignored by id, per the Env contract
        this.#timers.delete(e.id)
        if (meta.tag === TAG.redial && meta.to) { j.armed && j.emit(JK.dial, meta.to); this.env.sink.connect(meta.to) }
        else if (meta.tag === TAG.heartbeat) {
          for (const link of this.links.values())
            //! lower-uuid side originates PINGs (halves N² probe traffic — v2's rule, kept). Paused links
            // are SKIPPED entirely: control frames queued into a drop-oldest queue are doomed work, and a
            // drain would flush every stale r=1 digest at once, each triggering a duplicate suffix ship
            // from the peer at the exact moment backpressure cleared (adversarial-review finding). The
            // drain path has its own digest re-sync; a paused link needs no floor.
            if (link.state === LS.admitted && !link.paused && this.uuid < link.uuid) {
              link.ship(encodeControl(VERB.PING), this.env.sink, j)
              j.armed && j.emit(JK.ping, link.id)
              //! the periodic AE floor (plan §5 "periodic floor in ALL modes"): the same reciprocal digest
              // exchange that heals admits and drains, on the heartbeat cadence — belt-and-braces against
              // any loss mode WITHOUT a reconnect/drain signal (transport bugs, future non-TCP shells).
              // One r=1 digest from the PING side covers both directions: the reply ships our gaps, and
              // receiving their digest ships theirs. Nothing missing ⇒ nothing shipped (idempotent).
              // A client floors only its PRIMARY (the single-feeder rule — see the DIGEST handler).
              if (!this.client || link.id === this.primary) this.#sendDigest(link, 1)
            }
          //! membership acts on the heartbeat clock too (explicit protocol mode): genesis, suspicion,
          // eviction/join ballots, stale pulls, rejoin nudges — all only when heartbeats are on.
          this.membership.tick(this)
          //! the write pipeline's retry clock: in-flight attempts whose ACK/NACK never arrived re-park
          // after RETRY_TICKS and re-resolve + re-forward (cid dedup makes every retransmit safe).
          this.writes.tick(this)
          //! compaction rides the same clock (M4d): size-armed, frontier-bounded, journal-surfaced
          maybeCompact(this)
          //! M6: the scope machine's clock — orphan shed polls (with the shedStall alarm), latch
          // timeouts, and the probe-driven handshake re-round (kernel/scope.ts tick banner)
          if (this.armed) this.scope!.tick(this)
          //! the WAL snapshot (M4e) arms AFTER compaction so the swap captures the just-compacted log
          if (this.durable && this.#walRows >= SNAPSHOT_AT) this.snapshot()
          //! give-up revival: a target whose final redial attempt FAILED (gaveUp — never merely "tries
          // exhausted": the last armed attempt may still be pending, and dialing over it would fork a
          // second chain) is parked, not dead — each heartbeat re-dials any parked target we hold no link
          // to, with a fresh backoff chain (the M1 re-announce floor; full UDP discovery lands with
          // L0-complete). Targets are the static hosts PLUS the committed view's member listens
          // (adversarial-review wedge: a view-learned member — a joiner never in `hosts` — whose chain
          // gave up was parked FOREVER, stranding every attempt owner-routed to it). A live link to the
          // target — including one the PEER dialed — clears the stale give-up instead of dialing into a
          // dup race.
          for (const to of this.#revivable()) {
            if (to === this.listen) continue
            if (!this.#backoff.get(to)?.gaveUp) continue // never failed, or the redial chain still owns it
            let held = false
            for (const l of this.links.values()) if (!l.dead && (l.to === to || l.listen === to)) { held = true; break }
            this.#backoff.delete(to)
            if (held) continue
            j.armed && j.emit(JK.revive, to)
            this.env.sink.connect(to)
          }
          this.#armHeartbeat()
        }
        return
      }
      case 'write': {
        //! source=local into the single ingress (M3): epoch 0 + open gate is the M0/M1 fast path
        // (straight to commit); otherwise attempts are minted {cid, attemptEpoch, issuer} and routed —
        // committed here if we own the partition, forwarded to the owner if not, parked in the ONE
        // bounded queue if the gate is closed or the owner unreachable (kernel/write.ts).
        this.writes.issue(this, e.recs)
        return
      }
      default: {
        const never: never = e
        throw new Error(`unknown event ${(never as { kind: string }).kind}`)
      }
    }
  }

  //! commit — THE stamp site: {origin: me, seq: ++lamport, epoch: committed view}, then log, apply,
  // broadcast. Returns the FIRST stamped seq (a batch stamps contiguously — the write pipeline's
  // run-ACK coordinates derive from it). Called ONLY by kernel/write.ts (the single-ingress rule;
  // purity.test.ts lints the call sites) — local writes and inbound records share ONE ingest shape,
  // a local write being just the stream where origin === me. When the batch originated as a
  // forwarded/relayed ATTEMPT run, its identity (issuer, contiguous cids from baseCid) is logged and
  // broadcast with the records (FLAG_ATTEMPT), so replication feeds every node's cid-dedup window —
  // exactly-once then survives an ownership move (adversarial-review critical).
  commit(recs: Rec[], attempt?: AttemptRun): number {
    const j = this.journal
    //! the clock lease: stamping past the durable ceiling re-persists the boot record FIRST (sink.boot
    // is synchronous by contract), so a crash at ANY instant restores to a ceiling no stamp ever passed
    if (this.durable && this.seq + recs.length > this.#seqCeiling) this.persistBoot()
    const s0 = this.seq + 1
    for (let k = 0; k < recs.length; k++) {
      const rec = recs[k]
      const seq = ++this.seq
      const entry: { rec: Rec; seq: number; epoch: number; iss?: string; cid?: number; pp?: number } = { rec, seq, epoch: this.epoch }
      if (attempt) { entry.iss = attempt.issuer; entry.cid = attempt.baseCid + k }
      //! M6 pp (the floor law): the stamping owner is the ONE party that knows this (origin,
      // partition) sub-stream's predecessor — lastStamp, fed on EVERY scoped commit INCLUDING epoch
      // 0 (the panel's seam hole: an armed-gated feed would stamp the first post-arming commit
      // pp=0, forging first-ever over the genesis history) and NEVER cleared by shed (the
      // shed-then-reassigned-same-life window would re-forge pp=0; restarts rebirth the lane, so a
      // fresh map is truthful). Memory-only — unscoped nodes never touch it (byte-identity).
      let pp: number | undefined
      if (this.scoped) {
        const p = partitionOf(rec)
        pp = this.lastStamp.get(p) ?? 0
        this.lastStamp.set(p, seq)
        if (this.armed) entry.pp = pp
      }
      this.logFor(this.origin).push(entry) // the record is OWNED from here (embedder hands it over)
      this.apply(rec, this.origin, seq, this.epoch, entry.iss, entry.cid)
      j.armed && j.emit(JK.writeLocal, seq, rec.key[0] ?? rec.at ?? '')
      //! the own lane's ladder advances at the stamp site: applied+shippable together (logged and
      // applied in this same step); durable waits for the M4b storage batch to resolve
      const d = this.streams.for(this.origin)
      d.applied = d.shippable = seq
      //! M6 possession floor (armed only), under the SAME chain rule as ingest: the owner's floor
      // advances only when it covers its own predecessor stamp. This is not paranoia — a same-life
      // owner that SHED p and was later re-assigned it stamps with pp = its old lastStamp while its
      // floor re-starts at 0: the eager advance would claim the shed history it no longer holds
      // (the re-entry latch trues the floor first, then stamps chain normally).
      let holders: readonly string[] | null = null
      if (this.armed) {
        const p = partitionOf(rec)
        const pe = d.part(p)
        if (pp! <= pe.s && seq > pe.s) pe.s = seq
        this.scope!.mintHeld(this, p) // the owner holds what it stamps — the entry exists from the first commit
        const ring = this.writes.ring
        if (ring.epoch !== this.epoch) ring.build(this.epoch, this.membership.view.members)
        holders = ring.holders(p, this.replicas)
      }
      for (const link of this.links.values())
        //! live records flow only on SYNCED links (admitted + peer digest received): anything earlier is
        // covered by the digest-triggered suffix ship, and sending it live would leapfrog that suffix on
        // the wire and turn it into permanently-dropped "duplicates" at the receiver (the sweep-found bug).
        // M6 (armed): THE FAN-OUT FILTER — member links receive only their R-set's partitions; client
        // links keep the spoke tap. Orphans are excluded from the instant of install (they are not in
        // holdersOf) — the freeze that keeps the shed bar fixed (DESIGN-M6 C7). Armed sends carry pp
        // (link.add rotates frames at run discontinuities the filter creates).
        if (link.state === LS.admitted && link.synced &&
            (holders === null || link.client || holders.includes(link.uuid)))
          link.add(rec, { origin: this.origin, baseSeq: seq, epoch: this.epoch },
            attempt ? { issuer: attempt.issuer, baseCid: attempt.baseCid + k } : undefined,
            this.armed ? pp : undefined)
    }
    for (const link of this.links.values()) link.flush(this.env.sink, j)
    //! WAL the committed run (durable mode): the row is the SAME encoded frame shape the wire carries —
    // one format for log entry, WAL row, and payload (plan §7). One contiguous run ⇒ one frame.
    if (this.durable && recs.length) {
      const tail = this.logFor(this.origin).slice(-recs.length)
      const [bytes] = encodeRuns(tail.map((e) => ({ rec: e.rec, origin: this.origin, seq: e.seq, epoch: e.epoch, iss: e.iss, cid: e.cid, pp: e.pp })), undefined, this.armed)
      //! armed: the batch records per-partition maxes so its echo advances exactly the durable floors
      // this row covers (never a floor the WAL can't restore — DESIGN-M6 §0)
      let parts: Map<string, number> | undefined
      if (this.armed) {
        parts = new Map()
        for (const e of tail) { const p = partitionOf(e.rec); const m = parts.get(p); if (m === undefined || e.seq > m) parts.set(p, e.seq) }
      }
      this.persistRun(this.origin, this.seq, bytes, parts)
    }
    if (recs.length) this.confirm.recount(this) // own shippable advanced at the stamp site
    return s0
  }

  //! persistRun — leave one encoded frame with the store (durable mode only): mint the batch id, record
  // which (origin, maxSeq) the resolution will advance, link the row into the origin's chain (replay's
  // interior-hole detector), journal, emit. Kernel-internal (commit + ingest + replay's chain re-seed).
  persistRun(origin: string, maxSeq: number, bytes: Uint8Array, parts?: Map<string, number>) {
    if (!this.durable || this.#walDead) return
    const batch = ++this.#batchSeq
    const prev = this.walTail.get(origin) ?? 0
    this.walTail.set(origin, maxSeq)
    this.#inflight.set(batch, new Map([[origin, maxSeq]]))
    //! armed (M6): remember which per-(origin, partition) floors this batch's resolution may cover —
    // a COPY (rxParts is a reusable scratch); dirty partitions are excluded at ECHO time, not here
    // (a splice can dirty a partition while this batch is in flight).
    if (parts?.size) this.#inflightParts.set(batch, new Map([[origin, new Map(parts)]]))
    this.#walRows++
    this.journal.armed && this.journal.emit(JK.persist, batch, bytes.length)
    this.env.sink.persist(batch, bytes, prev)
  }

  //! snapshot — the whole-WAL snapshot+swap (M4e, the disk counterpart of M4d's compact): re-encode
  // EVERY current log entry (post-compaction: O(live cells)) into fresh rows with FRESH chain links
  // (each origin's chain restarts at prev=0) and hand the store the whole set to swap in atomically.
  // Loser history and orphaned rows vanish from disk exactly as they vanished from memory; original
  // stamps and attempt identities survive, so a restore from the swapped file is the same fold.
  // walTail resets to the new chain tails BEFORE the effect leaves — appends racing the swap chain
  // onto the snapshot, so a lied/torn swap turns them into chain holes replay detects (never a silent
  // gap). Durable advances to the log tails on the swap batch's persisted echo: everything in the log
  // is on disk from that instant. Cold path — tick-armed per SNAPSHOT_AT appended rows.
  snapshot() {
    if (!this.durable || this.#walDead) return
    //! BUILD first, COMMIT after: every row is encoded into locals before any node state mutates, so a
    // throw mid-encode (however unlikely) leaves walTail/inflight/counters untouched instead of half-
    // reset against the on-disk chain (M4-review finding). Chunks are contiguity-split exactly like
    // encodeRuns (each chunk encodes to EXACTLY one frame — asserted, so codec drift is a loud throw)
    // and additionally capped at 1024 records, keeping any single row far from MAX_FRAME.
    const rows: { bytes: Uint8Array; prev: number }[] = []
    const tails = new Map<string, number>()
    for (const [origin, entries] of this.logs) {
      if (!entries.length) continue
      let prev = 0
      let i = 0
      while (i < entries.length) {
        const h = entries[i]
        let j = i + 1
        while (j < entries.length && j - i < 1024 && entries[j].epoch === h.epoch && entries[j].seq === h.seq + (j - i) &&
               entries[j].iss === h.iss && (h.iss === undefined || entries[j].cid === h.cid! + (j - i))) j++
        const frames = encodeRuns(entries.slice(i, j).map((e) => ({ rec: e.rec, origin, seq: e.seq, epoch: e.epoch, iss: e.iss, cid: e.cid, pp: e.pp })), undefined, this.armed)
        if (frames.length !== 1) throw new Error('snapshot: chunk split diverged from encodeRuns')
        rows.push({ bytes: frames[0], prev })
        prev = entries[j - 1].seq
        i = j
      }
      tails.set(origin, prev)
    }
    const batch = ++this.#batchSeq
    this.walTail = tails
    this.#inflight.set(batch, new Map(tails)) // a COPY: walTail keeps moving with appends; the echo must cover the swap's tails only
    //! armed (M6): the swap captures the WHOLE fold — splices included — so its echo may advance every
    // durable floor to the possession floor as of THIS build, and clear the dirty entries whose
    // counters haven't moved since (a re-splice between build and echo stays dirty for the next swap).
    if (this.armed) {
      const floors = new Map<string, Map<string, number>>()
      for (const [origin, d] of this.streams) {
        if (!d.parts?.size) continue
        const per = new Map<string, number>()
        for (const [p, pe] of d.parts) if (pe.s > 0) per.set(p, pe.s)
        if (per.size) floors.set(origin, per)
      }
      this.#snapMeta.set(batch, { floors, clears: new Map(this.#dirty) })
    }
    this.#walRows = 0
    this.journal.armed && this.journal.emit(JK.snapshot, batch, rows.length)
    this.env.sink.snapshot(batch, rows)
  }

  //! condemn — the fsyncgate verdict on a lying disk (see `tainted`): reset the fold to empty, swap
  // the WAL clean (an empty snapshot — the liar's rows leave the disk with the taint, so the NEXT
  // restart replays a consistent file instead of re-detecting the same hole forever), and let
  // anti-entropy refold this node from the cluster. Called only from replay's chain check.
  condemn(origin: string) {
    this.tainted = true
    this.#resetFold()
    this.walTail.clear()
    //! the cid-dedup window resets WITH the fold (M4-review critical): coordinates learned from the
    // condemned rows would dup-ACK a retry for a record that may exist NOWHERE — silent acknowledged
    // loss. Forgetting degrades post-condemn retries to at-least-once (a same-value LWW supersede)
    // until replication re-feeds the window — the same documented class as M3's window eviction.
    this.writes.reset()
    this.journal.armed && this.journal.emit(JK.walTaint, origin)
    this.snapshot()
  }

  //! #resetFold — the fold wipe shared by condemn() (a lying disk) and a spoke's resync (a feeder whose
  // truth moved under it): logs, state, versions, streams, the rolling hash, and the M6 floor bookkeeping
  // (a wiped fold has no splices left to protect). Emits NOTHING downstream — the callers decide.
  #resetFold() {
    this.logs.clear()
    this.state.clear()
    this.versions.clear()
    this.streams = new Streams()
    this.#entryHash.clear()
    this.#hash = 0
    this.#dirty.clear()
    this.#inflightParts.clear()
    this.#snapMeta.clear()
    this.bootDirty.clear()
  }

  //! #resyncBegin (spokes) — take the feeder's truth: remember the cells held, wipe the fold, and ask the
  // feeder for everything with an EMPTY r=1 digest. Its suffix ship IS the re-download; its r=0 reply,
  // which it sends AFTER the ship on the same FIFO link, is the completion marker (#resyncEnd). The
  // projection downstream is left as it is until then — no remove-everything flicker; cells that come
  // back identical re-apply in place. The dedup window stays: WACKed coordinates were true when learned.
  #resyncBegin(link: Link) {
    const old = new Set(this.state.keys())
    this.journal.armed && this.journal.emit(JK.resync, old.size)
    this.#resetFold()
    this.resync = { old }
    this.#sendDigest(link, 1)
  }

  //! #resyncEnd — the feeder's reply arrived: every cell held at the reset that the re-download did not
  // bring back is a GHOST — removed downstream through the ordinary apply effect (a synthesized remove
  // under this node's own name, seq 0: never logged, never on the wire; a still-pending own write on
  // that cell shows again when its stamped echo arrives, exactly as after any foreign remove — V4-7).
  #resyncEnd() {
    const { old } = this.resync!
    this.resync = null
    let ghosts = 0
    for (const cell of old) {
      if (this.state.has(cell)) continue
      ghosts++
      this.env.sink.apply({ type: REC.remove, key: JSON.parse(cell) as string[], origin: this.uuid, seq: 0, epoch: 0 })
    }
    this.journal.armed && this.journal.emit(JK.resynced, ghosts)
  }

  //! persistBoot — (re)write the durable boot record: the committed view, the Lamport CEILING (the
  // lease — see LAMPORT_LEASE), the incarnation, and the SPENT ballot identity (a vote must be durable
  // before the VOTE frame leaves — membership calls this before shipping; the env's boot() contract is
  // write-before-later-sends).
  persistBoot() {
    if (!this.durable) return
    const m = this.membership
    this.#seqCeiling = this.seq + LAMPORT_LEASE
    this.env.sink.boot({
      //! identity rides the record (v4.1): restore recovers WHO this dir belongs to, so an omitted
      // config uuid can never half-restore under a fresh random identity (the silent evicted-heir
      // bug) — and WHAT it replicates, so a dir pointed at by the wrong resource refuses loudly.
      uuid: this.uuid,
      ...(this.name !== undefined ? { name: this.name } : {}),
      epoch: m.view.epoch,
      members: m.view.members.map((x) => [x[0], x[1]] as [string, string]),
      lamport: this.#seqCeiling,
      incarnation: this.incarnation,
      votedFor: { ...m.votedFor },
      //! M6 (armed only — unscoped boot bytes stay byte-identical): the dirty-partition ledger, the
      // data-authoritative held-set (a mid-latch entry rides under its PRE-latch classification;
      // the staged buffer itself is memory-only — C10 as amended by the review), the FROZEN orphan
      // half (finding 48), and the floor seed (the pp chain-rebuild's base — a stale seed is
      // honest-low, and replay advances from it through the WAL rows).
      ...(this.armed && this.#dirty.size ? { dirtyParts: [...this.#dirty.keys()] } : {}),
      ...(this.armed ? { heldPartitions: this.scope!.heldList(), orphanParts: this.scope!.orphanList(), floors: this.#floorSeed() } : {}),
    })
    this.journal.armed && this.journal.emit(JK.bootWrite, m.view.epoch, m.votedFor.e)
  }

  //! #floorSeed — the boot record's floor snapshot: per (origin, partition) [possession, durable].
  #floorSeed(): Record<string, Record<string, [number, number]>> {
    const out: Record<string, Record<string, [number, number]>> = {}
    for (const [origin, d] of this.streams) {
      if (!d.parts?.size) continue
      const per: Record<string, [number, number]> = {}
      let any = false
      for (const [p, pe] of d.parts) if (pe.s > 0 || pe.d > 0) { per[p] = [pe.s, pe.d]; any = true }
      if (any) out[origin] = per
    }
    return out
  }

  #armHeartbeat() {
    const id = ++this.#timerSeq
    this.#hbTimer = id
    this.#timers.set(id, { tag: TAG.heartbeat })
    this.env.sink.timer(id, TAG.heartbeat, this.#opts.heartbeatMs!)
  }

  //! #redial — jittered capped exponential backoff per target, BOUNDED attempts; jitter comes from env.rng so trajectories stay seed-reproducible.
  // The give-up after MAX_REDIALS is what keeps a refused target from keeping the
  // sim's event queue (and a real process's timer wheel) alive forever; it is
  // journal-visible, and the heartbeat tick revives a given-up target (so with
  // heartbeats on, one exhausted chain re-arms per heartbeat interval, bounded).
  // A successful identify resets the counter.
  #redial(to: string) {
    if (this.destroyed) return
    const base = this.#opts.redialMs ?? 100
    const b = this.#backoff.get(to) ?? { ms: base, tries: 0 }
    //! a PARKED target (discover forgot it while a link/dial still named it): the chain ends here and
    // the entry goes with it — no timer, no revival, nothing left to grow (#backoff stays bounded by
    // the live link set, not by every address a port-0 server ever had)
    if (b.parked) { this.#backoff.delete(to); return }
    if (b.tries >= MAX_REDIALS) {
      //! the final ARMED attempt has now FAILED — only here does the target become truly parked
      if (!b.gaveUp) {
        b.gaveUp = true
        this.#backoff.set(to, b)
        this.journal.armed && this.journal.emit(JK.giveUp, to)
      }
      return
    }
    this.#backoff.set(to, { ms: Math.min(b.ms * 2, base * 32), tries: b.tries + 1 })
    const delay = b.ms + Math.floor(this.env.rng() * base)
    const id = ++this.#timerSeq
    this.#timers.set(id, { tag: TAG.redial, to })
    this.env.sink.timer(id, TAG.redial, delay)
    this.journal.armed && this.journal.emit(JK.redial, delay, to)
  }

  //! #dispatch — per-frame verb routing; fails closed (journal + drop) on unknown verbs so control can never fall into the data path.
  #dispatch(link: Link, f: Frame) {
    const j = this.journal
    switch (f.verb) {
      case VERB.HELLO: {
        const v = f.value as { u?: unknown; i?: unknown; l?: unknown }
        if (typeof v?.u !== 'string' || typeof v.i !== 'number' || typeof v.l !== 'string') {
          j.armed && j.emit(JK.frameDrop, link.id, 'malformed hello')
          link.dead = true
          return this.env.sink.close(link.id, 'malformed-hello')
        }
        //! M7 DIAG (DESIGN-M7 §1): an r:2 HELLO is a diagnostics ATTACH, not a peer — the whole machine
        // lives in kernel/diag.ts; this is the one branch the safety-critical HELLO path grows. Checked
        // BEFORE self-reject/dup-link so a diag client can never perturb byUuid or evict a member by
        // presenting a spoofed uuid; the LS.diag leg catches a re-HELLO on an already-latched session.
        if (link.state === LS.diag || (v as { r?: unknown }).r === 2) return diagHello(this, link, v as Record<string, unknown>)
        //! resource-name refusal (v4.1): when BOTH ends declare a name and they differ, this link
        // reaches for a DIFFERENT resource — admit it and digest-on-admit would silently cross-
        // replicate two unrelated logs (a durable merge). Refuse loudly instead: dead + noRedial,
        // the same idiom as the self-reject below. One side declaring and the other not is the
        // legacy/embedder case — no check (absent means "no claim", never "any resource").
        {
          const n = (v as { n?: unknown }).n
          if (n !== undefined && typeof n !== 'string') {
            j.armed && j.emit(JK.frameDrop, link.id, 'malformed hello')
            link.dead = true
            return this.env.sink.close(link.id, 'malformed-hello')
          }
          if (typeof n === 'string' && this.name !== undefined && n !== this.name) {
            j.armed && j.emit(JK.nameReject, link.id, n)
            link.dead = link.noRedial = true
            //! a DIALED target answering for another resource is parked GIVEN-UP (never a redial chain —
            // that would hammer a misconfigured port), so the heartbeat's give-up revival re-dials it
            // once per heartbeat while it stays in hosts ∪ view: a squatter on the rendezvous, or a
            // resource that moves onto the right port later, heals at heartbeat cadence instead of
            // stranding this node forever (V4-3 panel: noRedial alone never started a chain, so
            // revival — which keys on gaveUp — could never reach the target)
            if (link.dialed && link.to) this.#backoff.set(link.to, { ms: this.#opts.redialMs ?? 100, tries: MAX_REDIALS, gaveUp: true })
            return this.env.sink.close(link.id, 'name-mismatch')
          }
        }
        if (v.u === this.uuid) {
          //! self-reject by uuid — a gossip loop or misconfig dialled ourselves; never redial a self-loop
          j.armed && j.emit(JK.selfReject, link.id)
          link.dead = link.noRedial = true
          return this.env.sink.close(link.id, 'self')
        }
        const existingId = this.byUuid.get(v.u)
        if (existingId !== undefined && existingId !== link.id) {
          const existing = this.links.get(existingId)!
          //! one-logical-link-per-pair: keep the link dialed by the lower uuid; both ends compute the same winner.
          // The loser is marked dead+noRedial and closed — its linkDown echo cleans the map; deleting it here
          // would make the echo look like a failed dial and re-dial the pair back into the race.
          if (dialedByLower(link, this.uuid, v.u) && !dialedByLower(existing, this.uuid, v.u)) {
            existing.dead = existing.noRedial = true
            this.env.sink.close(existingId, 'dup-link')
            j.armed && j.emit(JK.dupLink, existingId, link.id)
          } else {
            link.dead = link.noRedial = true
            this.env.sink.close(link.id, 'dup-link')
            j.armed && j.emit(JK.dupLink, link.id, existingId)
            return
          }
        }
        link.uuid = v.u; link.incarnation = v.i; link.listen = v.l
        if ((v as { r?: unknown }).r === 1) { link.client = true; this.clientLinks.add(link) }
        link.state = LS.admitted
        this.byUuid.set(v.u, link.id)
        //! reincarnation fences dead evidence: a peer identifying with a HIGHER incarnation crashed —
        // its previous life's confirm marks (shippable AND durable tails) may all have regressed, so
        // they are forgotten before anything recounts over them (M4-review: a replicated probe counted
        // a peer that provably held nothing; the compaction frontier trusted marks no disk backs).
        const prevInc = this.#peerInc.get(v.u) ?? 0
        if (v.i > prevInc) {
          if (prevInc > 0) { this.confirm.forget(v.u); this.scope?.forget(v.u) }
          this.#peerInc.set(v.u, v.i)
        }
        //! successful identify resets the redial backoff — by OUR dial target AND by the peer's gossiped
        // listen: when the peer dialed us while our own chain to it was mid-backoff (or a dup-race left
        // our dialed link the loser), the listen-keyed entry would otherwise orphan with gaveUp unset,
        // reporting dialing() forever and permanently holding eviction (review finding)
        if (link.to) this.#backoff.delete(link.to)
        if (v.l) this.#backoff.delete(v.l)
        j.armed && j.emit(JK.identified, link.id, v.u, v.i)
        //! digest-on-admit, ONE opener: the LOWER uuid sends the r=1 digest, the higher answers r=0
        // (2026-10-06). The rule is direction-independent — it asks who sorts lowest, never who dialed
        // (v2's dialer-gated catch-up trap is the counterexample) — and it is the PING/floor rule the
        // heartbeat already uses, so admit, drain and floor are all single-opener exchanges. One r=1
        // heals BOTH ways: the higher side ships what the opener's tails lack and then replies; that
        // reply's tails pull what the higher side lacks. Every admit heals — first link,
        // keeper-after-dup-race, reconnect-after-heal — and each missing suffix ships ONCE. (Both ends
        // used to open: each r=0 reply was built before the peer's first suffix had landed, so every
        // suffix shipped twice and the second copy dup-dropped.)
        // CLIENT exception (M5b): a client digests exactly ONE server — its primary. The first admit
        // elects it; every other link stays un-digested (and un-answered — see the DIGEST handler), so
        // synced never rises there and this client has ONE feeder: per-origin ordering by construction.
        // A server never opens toward a client: the client's own r=1 is what syncs that link.
        if (this.client) {
          if (this.primary === null) { this.primary = link.id; this.#sendDigest(link, 1) }
        } else if (!link.client && this.uuid < link.uuid) this.#sendDigest(link, 1)
        //! view-on-admit (from BOTH ends, unlike the digest): announce the committed view so a healed peer's
        // membership converges even when no epoch-stamped records flow; then settle — an admitted member
        // can flip the gate back to majority, flushing any parked writes
        this.membership.onAdmit(this, link)
        this.membership.settle(this)
        //! round-on-admit (M6-review findings 13/23/33/40/49 — DESIGN-M6 C3's mandated trigger): the
        // post-reconnect multi-source window creates interior holes suffix AE cannot fill (they sit
        // below the scalar lane tail), and a lost install-round offer otherwise re-heals only at the
        // next install. One batched HAVEQ round per admit re-announces + re-probes; it rides AFTER
        // the VIEW frame on this same FIFO link (finding 39's ordering rule), so a healed peer
        // installs the epoch before judging the round's epoch stamp.
        if (this.armed && !link.client) this.scope!.round(this)
        return
      }
      case VERB.RECORDS: {
        //! identity before admission, ENFORCED (link.ts's claim, adversarial review caught it unguarded):
        // records on a link that has not completed HELLO are a protocol violation — close, don't ingest.
        if (link.state !== LS.admitted) {
          j.armed && j.emit(JK.frameDrop, link.id, 'records before hello')
          link.dead = true
          return this.env.sink.close(link.id, 'records-before-hello')
        }
        //! a SPOKE never teaches (2026-09-06, DECISIONS V4-5): RECORDS on a client link drop — a spoke's fold
        // is a view of its feeder's, never a source, so servers learn from members only (a forged or stale
        // spoke could otherwise write any lane as "replication"). Frame dropped, link kept: a pre-fix spoke
        // that is ahead of us still ships — stale, not a wire fault.
        if (link.client) { j.armed && j.emit(JK.frameDrop, link.id, 'records from client'); return }
        const prov = f.prov()
        if (!prov) {
          //! M0: every RECORDS frame carries provenance; an un-stamped one is a protocol violation, not data
          j.armed && j.emit(JK.frameDrop, link.id, 'records without prov')
          return
        }
        //! the epoch-staleness contract (plan §5): a record stamped above my committed view epoch is
        // evidence of a view I missed — close the gate NOW and pull the view on this same link
        if (prov.epoch > this.epoch) this.membership.staleObserved(this, prov.epoch, link)
        let fresh = 0
        let maxSeq = 0
        //! armed: reset the per-frame partition scratch — fast-path APPENDS record their per-partition
        // maxes into it for the batch's durable-floor cover; SPLICES (flavor 2) deliberately don't
        // (no-interior-rows: they reach disk via snapshot, and node.spliced() already armed it)
        if (this.armed) { if (this.writes.rxParts) this.writes.rxParts.clear(); else this.writes.rxParts = new Map() }
        for (const rv of f.records()) {
          const flavor = this.writes.inbound(this, rv.origin, rv.seq, rv.epoch, rv)
          if (flavor === 1) { fresh++; maxSeq = rv.seq }
          else if (flavor === 2) fresh++
        }
        //! WAL the frame when it carried a fresh APPEND (durable mode) — the received bytes ARE the row
        // (copied out: the frame is a view pinned to the receive chunk). Duplicate records inside a
        // partially-fresh frame re-dedup on replay; the applied watermark makes that idempotent. A
        // splice-only frame persists NOTHING here (maxSeq would walk the chain backwards) — its bytes
        // reach disk inside the armed snapshot swap.
        if (maxSeq && this.durable) this.persistRun(prov.origin, maxSeq, f.buf.slice(), this.armed ? this.writes.rxParts ?? undefined : undefined)
        if (fresh) this.confirm.recount(this) // my shippable for this origin advanced — evidence for a probe
        //! flush the tap-forward (M5b): inbound() queued fresh records onto synced CLIENT links (the
        // spoke feed) — one flush per FRAME keeps the one-frame-per-tick shape on the client wire too
        if (fresh && this.clientLinks.size)
          for (const cl of this.clientLinks) cl.flush(this.env.sink, j)
        return
      }
      //! M3 write pipeline — WRITE (a forwarded attempt run / a client relay), WACK (commit
      // coordinates), WNACK (typed rejection). Identity-before-admission like everything else;
      // handlers live in kernel/write.ts. settle() runs after: an ACK/NACK can move the pending
      // queue, and a NACK's staleness evidence can flip the gate.
      case VERB.WRITE: {
        if (link.state !== LS.admitted) {
          j.armed && j.emit(JK.frameDrop, link.id, 'write before hello')
          link.dead = true
          return this.env.sink.close(link.id, 'write-before-hello')
        }
        this.writes.onWrite(this, link, f)
        this.membership.settle(this)
        return
      }
      case VERB.WACK:
      case VERB.WNACK: {
        if (link.state !== LS.admitted) {
          j.armed && j.emit(JK.frameDrop, link.id, 'write-ack before hello')
          link.dead = true
          return this.env.sink.close(link.id, 'write-ack-before-hello')
        }
        //! a CLIENT never owns a partition, so it never has an ACK or NACK to send: one arriving on an r:1
        // link is a forgery aimed at someone else's route (a parked relayed attempt has no owner of record
        // yet — `to` is '' — so the owner gate alone would let it through: cleared by a fake WACK, or ended
        // with a fake terminal `invalid` and a fake reason hopped to the victim). Drop the frame, keep the
        // link (a confused client is not a wire fault). Members are unaffected — one boolean per ACK frame.
        if (link.client) { j.armed && j.emit(JK.frameDrop, link.id, 'write-ack from client'); return }
        const v = f.value as Record<string, unknown>
        if (f.verb === VERB.WACK) this.writes.onAck(this, link, v)
        else this.writes.onNack(this, link, v)
        this.membership.settle(this)
        return
      }
      //! M5c method plane — the kernel ROUTES, the api host RUNS (purity: user handlers are arbitrary
      // async code). CALL/SUB/UNSUB surface as the invoke effect; RESULT/SUBREC surface as result/
      // subRecs. Malformed frames journal + drop (not link-fatal: the method plane is above the
      // replication contract, and a bad call must not sever a healthy data link).
      case VERB.CALL:
      case VERB.SUB: {
        if (link.state !== LS.admitted) {
          j.armed && j.emit(JK.frameDrop, link.id, 'rpc before hello')
          link.dead = true
          return this.env.sink.close(link.id, 'rpc-before-hello')
        }
        const v = f.value as { id?: unknown; m?: unknown; a?: unknown }
        if (typeof v?.id !== 'number' || typeof v.m !== 'string') {
          j.armed && j.emit(JK.frameDrop, link.id, 'malformed rpc')
          return
        }
        j.armed && j.emit(JK.rpcIn, f.verb, v.id, v.m)
        return this.env.sink.invoke(link.id, v.id, f.verb, v.m, v.a)
      }
      case VERB.UNSUB: {
        if (link.state !== LS.admitted) return
        const v = f.value as { id?: unknown }
        if (typeof v?.id !== 'number') return
        j.armed && j.emit(JK.rpcIn, f.verb, v.id, '')
        return this.env.sink.invoke(link.id, v.id, f.verb, '', undefined)
      }
      case VERB.RESULT: {
        if (link.state !== LS.admitted) return
        const v = f.value as { id?: unknown; ok?: unknown; v?: unknown }
        if (typeof v?.id !== 'number') return
        j.armed && j.emit(JK.rpcAnswer, v.id, v.ok === 1 ? 1 : 0)
        return this.env.sink.result(v.id, v.ok === 1, v.v, false) // a wire RESULT — a handler's reply, never a local failure
      }
      case VERB.SUBREC: {
        if (link.state !== LS.admitted) return
        const v = f.value as { id?: unknown; recs?: unknown }
        if (typeof v?.id !== 'number' || !Array.isArray(v.recs)) return
        return this.env.sink.subRecs(v.id, v.recs as Rec[]) // deliberately un-journaled: per-delta volume
      }
      case VERB.PING:
        return link.ship(encodeControl(VERB.PONG), this.env.sink, j)
      case VERB.PONG:
        return // proof of life; liveness accounting lands with M2 membership
      case VERB.DIGEST: {
        if (link.state !== LS.admitted) {
          j.armed && j.emit(JK.frameDrop, link.id, 'digest before hello')
          link.dead = true
          return this.env.sink.close(link.id, 'digest-before-hello')
        }
        const v = f.value as { d?: Record<string, unknown>; r?: number; p?: Record<string, unknown> }
        if (typeof v?.d !== 'object' || v.d === null) {
          j.armed && j.emit(JK.frameDrop, link.id, 'malformed digest')
          return
        }
        j.armed && j.emit(JK.digestIn, link.id)
        //! CLIENT single-feeder rule (M5b): a digest arriving on a NON-primary link goes unanswered and
        // un-shipped — answering would sync that server's side of the link and open a second broadcast
        // feeder, forking per-origin ordering. The evidence maps are still consumed (confirm is
        // side-effect-free reading); everything active is primary-only.
        if (this.client && link.id !== this.primary) {
          if (typeof v.p === 'object' && v.p !== null) this.confirm.sawP(link.uuid)
          for (const [origin, tail] of Object.entries(v.d))
            if (typeof tail === 'number') {
              const dur = typeof v.p?.[origin] === 'number' ? (v.p[origin] as number) : 0
              this.confirm.feed(this, link.uuid, origin, tail, dur)
            }
          this.confirm.recount(this)
          return
        }
        //! confirm evidence rides every digest: the d map IS the peer's shippable tails, the optional p
        // map its durable tails (sent only by durable-mode peers) — the ladder converges with zero new frames.
        // A p map's PRESENCE (even empty) marks the peer durable — the compaction frontier reads its
        // marks at markD from then on (crash-stable), never the volatile shippable tails.
        if (typeof v.p === 'object' && v.p !== null) this.confirm.sawP(link.uuid)
        for (const [origin, tail] of Object.entries(v.d))
          if (typeof tail === 'number') {
            const dur = typeof v.p?.[origin] === 'number' ? (v.p[origin] as number) : 0
            this.confirm.feed(this, link.uuid, origin, tail, dur)
          }
        this.confirm.recount(this)
        //! a SPOKE never teaches (2026-09-06, DECISIONS V4-5): its fold is a VIEW of its feeder's, so it ships
        // no suffix back — servers learn from members only (and drop RECORDS on client links). And when the
        // feeder's digest shows a lane tail BELOW ours, the cluster's truth moved under us — records died
        // with a server, or we failed over onto a lagging feeder — so the only honest move is to take the
        // feeder's truth: reset, re-download, remove what did not come back (#resyncBegin / #resyncEnd).
        // "Ahead of my feeder" is a TRUE signal on the single-feeder FIFO: at the instant a feeder builds a
        // digest, its tails cover everything it has ever shipped us (live tap-forwards included).
        if (this.client) {
          if (this.resync === null) {
            for (const [origin, d] of this.streams)
              if (d.applied > (typeof v.d[origin] === 'number' ? (v.d[origin] as number) : 0)) return this.#resyncBegin(link)
          } else if (v.r === 0) this.#resyncEnd()
          link.synced = true
          if (v.r === 1) this.#sendDigest(link, 0)
          return
        }
        //! a PAUSED link cannot deliver: serialising the missing suffix into its drop-oldest queue is
        // O(suffix) work per digest that overflow then discards (adversarial-review finding — the peer's
        // heartbeat floor would trigger it every tick for the whole pause). Mark the debt instead; the
        // drain-time digest exchange re-announces on a FLOWING link and ships once. synced deliberately
        // untouched: an unsynced link stays unsynced (live writes withheld) until a real exchange lands.
        if (link.paused) {
          link.droppedWhilePaused = true
          return
        }
        //! ship every suffix the peer's digest shows missing: for each origin I hold, everything past their
        // high-water. encodeRuns splits Lamport gaps into valid contiguous frames (attempt identity rides
        // along, so a healed peer rebuilds its cid-dedup window too); ship() honours backpressure.
        //! M6 (armed): the answer ships only partitions the REQUESTER may fold — a member link gets
        // its R-set's subset (ring-derived; slice 3b tightens to possession-announced), a client link
        // gets this node's HELD subset (an orphan's frozen copy is a teacher for holders, never a
        // spoke feed). Skipped entries gate-drop at the receiver anyway (§0 law row 1) — the filter
        // keeps the wire honest and the promiscuous-stage hole (3b) closed at the never-sent leg.
        const scopedTo = this.armed
          ? (p: string) => link.client ? this.scope!.held(p) : this.writes.ring.holdsAny(link.uuid, p, this.replicas)
          : null
        if (scopedTo !== null && this.writes.ring.epoch !== this.epoch)
          this.writes.ring.build(this.epoch, this.membership.view.members)
        let shipped = 0
        for (const [origin, entries] of this.logs) {
          const theirs = typeof v.d[origin] === 'number' ? (v.d[origin] as number) : 0
          let lo = entries.length
          while (lo > 0 && entries[lo - 1].seq > theirs) lo-- // entries are seq-ascending; find the missing suffix
          if (lo === entries.length) continue
          let tail = entries.slice(lo)
          if (scopedTo !== null) tail = tail.filter((e) => scopedTo(partitionOf(e.rec)))
          if (!tail.length) continue
          //! armed AE answers carry each entry's STORED pp (the floor law): the receiver's floors
          // advance only through chain-verified spans, so a suffix landing above a gap folds without
          // forging coverage of the still-missing interior (finding 10's AE leg / the multi-source
          // interleave). Unscoped answers stay flag-free — bytes unchanged.
          const missing = tail.map((e) => ({ rec: e.rec, origin, seq: e.seq, epoch: e.epoch, iss: e.iss, cid: e.cid, pp: e.pp }))
          for (const bytes of encodeRuns(missing, undefined, this.armed)) link.ship(bytes, this.env.sink, j)
          shipped += missing.length
        }
        if (shipped) j.armed && j.emit(JK.aeShip, link.uuid, shipped)
        //! the peer's digest is what SYNCS the link: the suffix just shipped covers everything up to this
        // instant, and every record from here on has a higher seq — per-origin monotonicity holds on the wire
        link.synced = true
        //! r=1 means "answer with yours" — the reply carries r=0, so the exchange is two-legged, never a loop
        if (v.r === 1) this.#sendDigest(link, 0)
        return
      }
      //! M6 scoped-replication plane (DESIGN-M6 C3/C8): HAVEQ/HAVEA carry the possession handshake,
      // ACQ/ACQDONE the one-teacher transfer. Admitted-only like everything else; a frame arriving on
      // an UNSCOPED node journals + drops (a scoped peer talking to an R=∞ node is a deploy-config
      // drift — surfaced, never a crash and never a link kill: the data plane above it is healthy).
      case VERB.HAVEQ:
      case VERB.HAVEA:
      case VERB.ACQ:
      case VERB.ACQDONE: {
        if (link.state !== LS.admitted) {
          j.armed && j.emit(JK.frameDrop, link.id, 'scope before hello')
          link.dead = true
          return this.env.sink.close(link.id, 'scope-before-hello')
        }
        if (!this.armed) { j.armed && j.emit(JK.frameDrop, link.id, 'scope frame while unscoped'); return }
        if (f.verb === VERB.HAVEQ) this.scope!.onHaveQ(this, link, f.value as never)
        else if (f.verb === VERB.HAVEA) this.scope!.onHaveA(this, link, f.value as never)
        else if (f.verb === VERB.ACQ) this.scope!.onAcq(this, link, f as never)
        else this.scope!.onAcqDone(this, link, f.value as never)
        return
      }
      //! M2 membership control plane — identity-before-membership: all six verbs require admission,
      // like DIGEST (a pre-admission membership frame is a protocol violation → close). Handlers live
      // in kernel/membership.ts; settle() runs after each so gate transitions journal and buffered
      // writes flush the moment a frame opens the gate.
      case VERB.JOIN:
      case VERB.PROPOSE:
      case VERB.VOTE:
      case VERB.VIEW:
      case VERB.PULL:
      case VERB.LEAVE: {
        if (link.state !== LS.admitted) {
          j.armed && j.emit(JK.frameDrop, link.id, 'membership before hello')
          link.dead = true
          return this.env.sink.close(link.id, 'membership-before-hello')
        }
        //! a SPOKE never teaches membership either (I-23, 2026-09-28 — V4-5 carried to the control plane):
        // a client is in nobody's view, so it has no VIEW to announce, no ballot to open or answer, nothing
        // to join or leave. A VIEW accepted from one is how reborn memory-only members adopted a client's
        // stale view (a view they were not in — `evicted`, genesis impossible, the cluster never re-formed).
        // Frame dropped, link kept — a pre-fix spoke flooding its view is stale, not a wire fault. Its PULL
        // is a QUESTION, not a teaching: still answered, so a stale spoke can ask for the live view.
        if (link.client && f.verb !== VERB.PULL) { j.armed && j.emit(JK.frameDrop, link.id, 'membership from client'); return }
        const v = f.value as Record<string, unknown>
        if (f.verb === VERB.JOIN) this.membership.onJoin(this, link, v)
        else if (f.verb === VERB.PROPOSE) this.membership.onPropose(this, link, v)
        else if (f.verb === VERB.VOTE) this.membership.onVote(this, link, v)
        else if (f.verb === VERB.VIEW) this.membership.onView(this, link, v)
        else if (f.verb === VERB.PULL) this.membership.onPull(this, link, v)
        else this.membership.onLeave(this, link)
        this.membership.settle(this)
        return
      }
      //! M7 DIAG plane (cold cases, after every hot verb): per-frame auth is the LATCH state check
      // alone — a DIAGQ outside an authenticated session is the records-before-hello shape (close);
      // a DIAGA arriving at a node is a confused client (drop the frame, keep the link — the
      // default-arm posture, since it proves nothing hostile).
      case VERB.DIAGQ: {
        if (link.state !== LS.diag) {
          j.armed && j.emit(JK.frameDrop, link.id, 'diagq outside session')
          link.dead = link.noRedial = true
          return this.env.sink.close(link.id, 'diag-denied')
        }
        return onDiagQ(this, link, f.value as Record<string, unknown>)
      }
      case VERB.DIAGA:
        j.armed && j.emit(JK.frameDrop, link.id, 'unexpected diaga')
        return
      default:
        j.armed && j.emit(JK.frameDrop, link.id, `unknown verb ${f.verb}`)
        return // drop the frame, keep the link — an unknown verb from a newer peer is not a wire fault
    }
  }

  //! logFor — per-origin log accessor (get-or-create). Kernel-internal: called by commit above and by
  // the write module's inbound ingest (source=inbound lives in kernel/write.ts with the other sources).
  logFor(origin: string): { rec: Rec; seq: number; epoch: number; iss?: string; cid?: number }[] {
    let l = this.logs.get(origin)
    if (!l) { l = []; this.logs.set(origin, l) }
    return l
  }

  //! #sendDigest — announce {origin: highestHeldSeq} (the log tails: exactly what this node can serve).
  // Durable mode adds the p map (durable tails) — the persisted-confirm evidence; non-durable digests
  // are byte-identical with M0-M3.
  #sendDigest(link: Link, r: 0 | 1) {
    const d: Record<string, number> = {}
    for (const [origin, entries] of this.logs) if (entries.length) d[origin] = entries[entries.length - 1].seq
    let body: { d: Record<string, number>; r: number; p?: Record<string, number> }
    if (this.durable) {
      const p: Record<string, number> = {}
      for (const [origin, s] of this.streams) if (s.durable > 0) p[origin] = s.durable
      body = { d, r, p }
    } else body = { d, r }
    link.ship(encodeControl(VERB.DIGEST, body), this.env.sink, this.journal)
    this.journal.armed && this.journal.emit(JK.digestOut, link.id, r)
  }

  //! apply — the ONE record→state function (plan §3.3: exactly one projection path). Runs the per-cell
  // LWW election, mutates the state mirror, and emits the apply effect downstream. A record that loses
  // its election is SKIPPED but its stream watermark still advances (the caller's job) — losing is not
  // loss. Kernel-internal: called by commit and by the write module's inbound ingest, nothing else.
  // `iss`/`cid` (M5a): the attempt identity when the caller holds one — riding the Applied effect so
  // the embedder can join ITS OWN writes against the apply stream (env.ts Applied; the api layer's
  // write promises and settlement-index drops key off exactly this join).
  apply(rec: Rec, origin: string, seq: number, epoch: number, iss?: string, cid?: number) {
    const k = JSON.stringify(rec.key.length ? rec.key : [rec.at ?? '']) // unambiguous internal key — wire keys stay length-prefixed
    //! LWW: lexicographic (epoch, seq, origin), identical on every node — apply iff strictly newer than the held stamp
    const cur = this.versions.get(k)
    if (cur && (epoch < cur.epoch || (epoch === cur.epoch && (seq < cur.seq || (seq === cur.seq && origin <= cur.origin))))) {
      this.journal.armed && this.journal.emit(JK.lwwSkip, origin, seq)
      return
    }
    this.versions.set(k, { epoch, seq, origin }) // a remove leaves this as a tombstone deliberately
    const old = this.#entryHash.get(k)
    if (old !== undefined) { this.#hash = (this.#hash - old) | 0 }
    if (rec.type === REC.remove) {
      this.state.delete(k)
      this.#entryHash.delete(k)
    } else {
      this.state.set(k, rec.value)
      const h = fnv(k + '' + stable(rec.value))
      this.#entryHash.set(k, h)
      this.#hash = (this.#hash + h) | 0
    }
    this.env.sink.apply({ type: rec.type, key: rec.key, value: rec.value, at: rec.at, origin, seq, epoch, iss, cid })
  }

  //! stateHash — order-insensitive rolling hash over entries: O(1) per apply, comparable per event (the sim's convergence + replay-determinism checks key off it).
  get stateHash(): number { return this.#hash | 0 }

  //! dropCell — remove one state cell OUTSIDE the LWW election (M6 shed: the data lawfully leaves
  // this node without a remove record existing anywhere). Maintains the rolling hash exactly like
  // apply()'s remove arm — a shed that bypassed this would silently poison every convergence check.
  dropCell(k: string) {
    const old = this.#entryHash.get(k)
    if (old !== undefined) { this.#hash = (this.#hash - old) | 0; this.#entryHash.delete(k) }
    this.state.delete(k)
  }

  //! admitted — identified peer uuids (harness predicate: cluster formed ⇔ everyone admits everyone).
  // Dead links are EXCLUDED even before their linkDown echo: a dup-race loser is marked dead
  // synchronously, and counting it double-counted its uuid in genesis membership (review finding —
  // a committed view with a duplicated member permanently poisons majority arithmetic).
  admitted(): string[] {
    const out: string[] = []
    for (const l of this.links.values()) if (l.state === LS.admitted && !l.dead) out.push(l.uuid)
    return out
  }

  //! destroy — tear down every link and timer via effects (the env echoes linkDowns which are then ignored).
  destroy() {
    if (this.destroyed) return
    this.destroyed = true
    for (const id of this.links.keys()) this.env.sink.close(id, 'destroy')
    for (const id of this.#timers.keys()) this.env.sink.cancel(id)
    this.#timers.clear()
  }
}

//! fnv — fnv-1a over a string; the per-entry hash the rolling state hash sums.
const fnv = (s: string): number => {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) }
  return h | 0
}
//! stable — deterministic stringify (sorted object keys, NaN- and bytes-aware) for hashing and state
// comparison only; never on the wire path. Exported so sim monitors diff values with the SAME notion of
// equality the hash uses (JSON.stringify can't tell NaN from null — a diff that lies is worse than none).
export const stable = (v: unknown): string => {
  if (v === undefined) return 'u'
  if (v === null || typeof v !== 'object') return typeof v + ':' + String(v)
  if (v instanceof Uint8Array) return 'b:' + Array.from(v).join(',')
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']'
  return '{' + Object.keys(v).sort().map((k) => k + '=' + stable((v as Record<string, unknown>)[k])).join(',') + '}'
}
