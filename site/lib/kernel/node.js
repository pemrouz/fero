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

import { Framer, FrameError, VERB, continuesRun, encodeControl, encodeRuns,                             } from './codec.js'
import { Link, LS, dialedByLower } from './link.js'
import { JK, Journal } from './journal.js'
import { Membership } from './membership.js'
import { Writes } from './write.js'
import { Streams } from './streams.js'
import { Confirm } from './confirm.js'
import { Scope, SCOPE } from './scope.js'
import { diagHello, onDiagQ } from './diag.js'
import { maybeCompact } from './log.js'
import { tuneOf,           } from './tune.js'
import { RING } from './ring.js'
import { NONCE_MIN, NONCE_MAX, PROOF_LEN, addressOk, contractDiff, prove, verify,                           } from './door.js'
import { REC, TAG, partitionOf,                                } from './env.js'

//! the three node-level defaults live in kernel/tune.ts (it is imported here, so defining them here
// would be an import cycle); re-exported under their old names for the tests and tools that import them
export { MAX_REDIALS, MEMBER_REDIALS, LAMPORT_LEASE, SNAPSHOT_AT } from './tune.js'

//! LogEntry: one lane entry — the record with its stamp, the attempt identity it committed from (iss/cid,
// when it did) and its (origin, partition) predecessor pp (armed senders only). The lanes and the
// per-partition index (byPart) hold the SAME objects.
                                                                                                        

//! NodeOpts: explicit boot facts — no config-shape sniffing (v2's hasPeers heuristic is banned by plan §9).
                           
              
                                                                                                   
                                                                                                  
                                                                                                     
                                                                                                    
                                                                                                      
                                                                                      
               
                                                                  
                                                                     
                                                                                                        
                                                                                  
                                                        
                                                                                                        
                                                                                                      
                                                                                                     
                                                                                             
                   
                                                                                                        
                                                                                                 
                                                                                                         
                                                                                       
                                                                                                                                                                           
                                                                                                      
                                                                                                      
                                                                                                    
                                                                                                    
                                                                                  
                  
                                                                                                   
                                                                                                  
                                                                                                 
                                                                                                     
                                                                                                  
                                                                                                 
                                                                
                   
                                                                                                       
                                                                                                      
                                                                                                     
                                                                                                    
                                                                                  
                                          
                                                                                                        
                                                                                                      
                                                                                                     
                                                                                                      
                                                                                                       
                                                                                                      
                                                                                                   
                                                                                                       
                                        
                                                                                                            
                                                                                                            
                                                                                                          
                                                                                                            
                                                                                                        
                                                                                                         
                                                                                                          
                                                                                                      
                                                                                                           
                                                                                                          
                                     
                                                                                                     
                                                                                             
                                                                                                        
                                                                                                       
                                                                                                        
                                                                                                      
                   
                                                                                                     
                                                                                                   
                       
                                                                                                         
                                                                                                        
                                                                                                      
                             
                                                                                                      
                                                                                                       
                                                                                                  
                                                                                                         
             
                                                                                                       
                                                                                                       
                                                                                                  
                      
                                                                                                             
                                                                                                            
                                                                                                   
                                                                                                        
                                                                                                        
                                
                       
 

export class Node {
  //! tune — the frozen table every read site consults (`node.tune.<row>`). Assigned FIRST in the
  // constructor, before anything that could read a row; never read from a field initializer.
           tune                
           uuid        
  //! name — the resource identity this node replicates; rides HELLO so a misdial onto another
  // resource's port refuses instead of silently merging logs (see NodeOpts.name). Optional: absent
  // (sim harness, embedders) disables the check and keeps the HELLO body byte-identical with v4.0.
           name         
  //! contract — the full string HELLO carries (NodeOpts.contract + the kernel's `;ring=` part); undefined = no claim
           contract         
           methodsOnly         
  //! listen — my dialable address, gossiped in HELLO. Assignable (V4-3): a shell that binds port 0 writes
  // the OS-chosen address here inside its listen callback — before the start stimulus and before any
  // accepted socket can HELLO — and the kernel reads it only at send/propose time. Assignment invalidates
  // the cached hosts (own listen is excluded from the dial set).
  #listen = ''
  get listen()         { return this.#listen }
  set listen(v        ) { this.#listen = v; this.#hostsCache = null }
           incarnation        
  //! origin — THE PROVENANCE LANE this life stamps under: the bare uuid for incarnation 1, uuid~inc
  // for reborn lives (so first lives — and every pre-M4 trajectory — are byte-identical on the wire).
  // The lane is what makes crash recovery structurally sound: a previous life's stream becomes an
  // IMMUTABLE FOREIGN stream the reborn re-syncs via ordinary suffix anti-entropy (its chain-truncated
  // replay left a clean tail), instead of an unhealable interior hole inside one shared log — one log
  // cannot serve two lives once the clock lease jumps past the lost records. The Lamport CEILING keeps
  // new-lane stamps LWW-dominant over everything the old lane wrote ("incarnation fences flappers and
  // stops dead-origin debris" — plan §5, made concrete). Old lanes are debris compaction sweeps (M4d).
           origin        
  journal         
  //! links by env-minted id; byUuid enforces one-logical-link-per-pair (kernel/link.ts keeper rule)
  links = new Map              ()
  byUuid = new Map                ()
  //! replication state — explicit fields, not closure captures.
  // `seq` IS the Lamport clock: it merges up on every inbound record and
  // increments on every local write, so a local write is always causally newest
  // (v2 DECISIONS A, kept). Convergence then follows from per-cell LWW below.
  seq = 0
  epoch = 0
  //! membership (M2): committed views, ballots, the write-gate. The data plane below stays open —
  // membership gates COMMITS and majority math, never replication (an evicted node still converges).
  membership            
  //! writes (M3): THE single write ingress — attempts, cid dedup, owner routing/forwarding, the ONE
  // bounded pending queue. Local 'write' events, forwarded WRITE frames, and inbound RECORDS all
  // enter the system through this object (kernel/write.ts is the stamp-site module).
  writes = new Writes()
  //! confirm (M4c): the guarantee ladder — probes over the watermark evidence (kernel/confirm.ts)
  confirm = new Confirm()
  //! scope (M6): the per-partition scoped-replication state machine (kernel/scope.ts) — constructed
  // only on scoped nodes, consulted only when armed; null at R=∞ (structurally unreachable unscoped).
  scope               = null
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
  versions = new Map                                                        ()
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
  logs = new Map                    ()
  //! byPart (DESIGN-SCALE stage 1, M4): partition → lane → that lane's (lane, p) entries, seq-ascending, the
  // SAME objects the lanes hold. Scoped nodes only (null at R=∞: every site pays one null check, nothing
  // else — unscoped bytes and trajectories are untouched). Every site that puts an entry in a lane, takes one
  // out, or replaces a lane keeps it in step: commit (below), inbound/splice/replay (write.ts), the ACQDONE
  // fold and the shed (scope.ts), compact (log.ts), #resetFold. The hand-over paths read it instead of
  // walking every lane: #teach, #tailsOf, #abort, #shed and rescope's partition census are O(entries of p),
  // not O(entries of the node). The sim's M4 index-oracle re-derives it from the lanes after every event.
  byPart                                              = null
  //! tombs (the same stage): partition → the cells whose version is a TOMBSTONE (a stamp with no live value:
  // a remove's, or a field a parent write swept). Scoped nodes only. Kept by apply (the remove arm, the sweep,
  // a cell written live again), tombstone GC, the shed and #resetFold; the shed drops a partition's versions
  // through it instead of parsing every key the node holds.
  tombs                                  = null
  //! M6 pp (the floor law): the last seq this life stamped per partition — the sub-stream
  // predecessor the NEXT own-lane stamp carries. Fed on every scoped commit (epoch 0 included) and
  // NEVER cleared by shed (a shed-then-reassigned same-life owner must not re-stamp pp=0 over its
  // own shed history); restarts rebirth the origin lane, so a fresh map is truthful. Memory-only.
  lastStamp = new Map                ()
  //! M0 downstream state: a flat path→value map + an order-insensitive rolling hash.
  // The api layer binds a $() proxy to sink.apply() later (M5); the kernel keeps
  // this mirror so sim monitors and the replay/state-hash check (plan §3.1) can
  // interrogate state without reaching through a proxy.
  state = new Map                 ()
  #entryHash = new Map                ()
  #hash = 0
  //! deep (V4-18, overlapping cells): the field cells, by ancestor. Key = an ancestor path's key
  // ('["g"]', '["g","a"]'); value = every cell of depth ≥ 2 under it — LIVE ones and TOMBSTONES alike,
  // each registered under each of its ancestors. So a write at any depth finds exactly its own subtree
  // in one lookup (its own key), and a field REMOVE stamped above its row is found again after a late
  // older row write and re-applied downstream. The invariant: an indexed cell's stamp is strictly newer
  // than every ancestor's version. A row cell (depth 1) is nobody's descendant, so a partition written
  // only as whole rows has no entry here and the index costs it nothing. Kept in step by apply (link
  // on apply, unlink on sweep), dropCell, tombstone GC and #resetFold; shed walks it instead of
  // scanning every key. No set is ever left empty.
  deep = new Map                     ()
  //! timers — kernel-minted ids; fired ids not in #timers are stale (cancel raced the fire) and ignored.
  // `to` rides a redial, `link` a proving deadline (TAG.prove).
  #timerSeq = 0
  #timers = new Map                                                     ()
  //! gaveUp distinguishes "parked after the final attempt FAILED" from "the final attempt is still
  // pending" — tries increments at ARM time, so tries alone cannot tell them apart, and a revival
  // during the pending window would orphan the live timer into a second concurrent dial chain
  // (adversarial-review finding: forked chains, doubled dial traffic, starved giveUp).
  //! parked (V4-3): a forgotten DYNAMIC target that a live link (or an in-flight dial) still names —
  // kept only so that link's eventual linkDown ends the chain instead of starting one; nothing dials,
  // revives, or counts a parked target, and #redial drops the entry the moment it is consulted
  //! member (2026-10-08): the chain started by the death of an ADMITTED MEMBER link — a crashed member.
  // It is capped at tune.memberRedials (never more than tune.redials); every other chain at tune.redials.
  // A member link's death always leaves the member chain: a generic chain or an orphaned timer already
  // pointed at the target is cancelled and the member chain starts fresh (#redial); a member chain keeps going.
  #backoff = new Map                                                                                             ()
  //! highest incarnation ever identified per peer uuid — a HELLO above it means the peer was REBORN,
  // and every evidence mark its previous life announced is void (confirm.forget; see that banner).
  #peerInc = new Map                ()
  #hbTimer = -1
  destroyed = false
  env     
  #opts          

  //! M4b storage plumbing: WAL batches in flight (batch → per-origin max seq, resolved into the durable
  // watermark on the 'persisted' echo), the per-origin WAL CHAIN TAIL (each row records the seq its
  // origin's chain stood at — replay's interior-hole detector), the dead-WAL latch (a persistFail is
  // terminal: fsyncgate — a store that failed once may have lied about anything since), and the
  // boot-time replay framer. All empty/idle when durable is off.
  #batchSeq = 0
  #inflight = new Map                             ()
  //! M6 armed-durable bookkeeping (all empty unscoped): per-batch (origin, partition) covers for the
  // durable-floor advance; the DIRTY set — partitions holding a memory-only splice (counter per
  // partition: a re-splice between a snapshot's build and its echo must survive the echo's clear);
  // the per-snapshot metadata {floors at build, dirty counters at build} its echo commits.
  #inflightParts = new Map                                          ()
  #dirty = new Map                ()
  #snapMeta = new Map                                                                                   ()
  //! boot-restored M6 facts (C10): the foldable set of the previous life (held ∪ orphaned — null =
  // record absent / unscoped), the FROZEN half (finding 48: restored orphans re-enter only through
  // the latch, even when the restored ring re-assigns them), and the partitions whose replay floors
  // must NOT rebuild (see BootRecord.dirtyParts).
  bootHeld                     = null
  bootOrphans                     = null
  bootDirty = new Set        ()
  bootAt0 = true
  get bornAt0()          { return this.bootAt0 }
  set bornAt0(v         ) { this.bootAt0 = v }
  walTail = new Map                ()
  #walDead = false
  #seqCeiling = 0
  #replayer                = null
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

  constructor(opts          , env     ) {
    this.tune = tuneOf(opts.tune) // first: validated and frozen before any row can be read
    this.env = env
    this.journal = new Journal(opts.journalCap)
    this.uuid = opts.uuid
    this.name = opts.name
    this.contract = opts.contract !== undefined ? `${opts.contract};ring=${RING}` : undefined
    this.methodsOnly = opts.methodsOnly === true
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
          //! capped at the durable floor (DESIGN-SCALE §2, the A4 seed probe): the boot record is written
          // synchronously while WAL rows are fsynced later, so its possession half can claim rows a crash
          // tore off. Only `d` is backed by rows the disk restored; replay advances `s` from there.
          pe.s = Math.min(sd[0], sd[1])
          pe.d = sd[1]
        }
    if ((opts.replicas ?? 0) > 0) { this.scope = new Scope(); this.byPart = new Map(); this.tombs = new Map() } // (this.#opts assigns below — read opts directly)
    //! the Lamport floor from the boot record: even if the WAL tail was torn, the clock never restarts
    // below the last durably-recorded stamp (seq reuse under one origin would collide provenance)
    this.seq = opts.boot?.lamport ?? 0
    this.#opts = opts
  }

  //! durable — the M4 storage mode (explicit, like heartbeats). Off ⇒ zero storage effects.
  get durable()          { return this.#opts.durable === true }

  //! client — the M5b role mode (see NodeOpts.client). Off ⇒ zero behavioural difference.
  get client()          { return this.#opts.client === true }

  //! replicas — the M6 scoped-replication mode (see NodeOpts.replicas). 0 ⇒ unscoped (R=∞), the
  // machinery is inert; scoped() is the one branch guard every M6 code path hangs off.
  get replicas()         { return this.#opts.replicas ?? 0 }
  get scoped()          { return (this.#opts.replicas ?? 0) > 0 }
  //! heartbeats — is the protocol clock on? (heartbeatMs 0 is the explicit sweep mode: no ticks ever fire,
  // so a tick-bounded wait — the leave drain — must not be entered)
  get heartbeats()          { return (this.#opts.heartbeatMs ?? 0) > 0 }

  //! diagAllow — the M7 DIAG allowlist (see NodeOpts.diag). Absent/empty ⇒ the channel is dead: every
  // r:2 HELLO is denied (fail closed, the durable/client/replicas idiom for absent modes).
  get diagAllow()                                     { return this.#opts.diag?.allow }

  //! validate — the relay-ingress admission predicate (see NodeOpts.validate). Absent ⇒ every relayed
  // record is admitted; onWrite's relay branch pays one undefined-check per FRAME, nothing per record.
  get validate()                                            { return this.#opts.validate }

  //! admit — the owner's re-check of a forwarded remove under a row (see NodeOpts.admit). Read on the
  // forwarded leg of onWrite, armed only; absent ⇒ no re-check.
  get admit()                                            { return this.#opts.admit }

  //! door — the secret's two functions (see NodeOpts.door). Absent ⇒ the open door: the HELLO path pays
  // one undefined-check per HELLO and per linkUp, nothing per record.
  get door()                   { return this.#opts.door }

  //! armed — scoping is LIVE: scoped ∧ a committed view exists. Open genesis (epoch 0) is always
  // unscoped — there is no committed ring to scope against, every node owns its own writes, and the
  // epoch-0 fast path must stay byte-identical (DESIGN-M6 rule 3). Every scoped branch in the
  // replication plane guards on THIS, never on `scoped` alone.
  get armed()          { return this.scoped && this.epoch > 0 }

  //! spliced — a dual-fence splice landed for partition p (armed ingest only). Durable bookkeeping:
  // the splice is memory-only (an interior row would walk walTail backwards and condemn the chain on
  // replay), so the partition goes DIRTY and the snapshot swap is armed — the next tick's whole-WAL
  // swap captures the lane in order. The FIRST transition to dirty persists the boot record
  // synchronously: a crash before the swap must restore with this partition's floors zeroed
  // (BootRecord.dirtyParts), or replay's row-max rebuild would attest coverage of the lost interior.
  spliced(p        ) {
    if (!this.durable) return
    const n = this.#dirty.get(p)
    this.#dirty.set(p, (n ?? 0) + 1)
    this.#walRows = this.tune.snapshotAt // arm: the next heartbeat tick swaps the WAL
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
  replayHeld(p        , origin         )          {
    if (origin !== undefined && (origin === this.uuid || origin.startsWith(this.uuid + '~'))) return true
    return this.bootHeld === null || this.bootHeld.has(p)
  }

  //! primary — the client's ONE feeder link id (null while unconnected). Kernel-internal to the client
  // role; the write drain targets it, digests flow only over it, failover re-elects on its linkDown.
  primary                = null
  //! feederOpen — the client's copy of its PRIMARY's write-gate, from the `w` its digests carry (I-33):
  // null while unknown (no feeder, a fresh feeder that has not digested yet, or an older server that
  // sends no `w`). One heartbeat behind the feeder at worst; the api's `cluster.writable` on a client.
  feederOpen                 = null
  //! feederMethodsOnly (DESIGN-DOOR §4) — did the PRIMARY's HELLO say methods-only (`m: 1`)? Read LIVE off
  // the primary link, never copied at admit: HELLO is sent once per link, so a copy reset on failover
  // (the feederOpen shape above) could never be refilled. False with no primary, or an old server that
  // sends no `m`: the write then takes the round trip and the relay's door refuses it as before.
  get feederMethodsOnly()          { return this.primary !== null && (this.links.get(this.primary)?.methodsOnly ?? false) }
  //! feederContract (DESIGN-SCALE stage 1) — the PRIMARY's HELLO contract (`c`), read live off the primary
  // link for the same reason as feederMethodsOnly. The api reads `replicas=` out of it: a client of a
  // SCOPED feeder sees only the partitions its feeder holds, so a row absent from its fold may well live
  // at an owner, and a delete of it is a real remove to send. With NO primary (every server link down —
  // an outage, a redial in progress) it is the LAST primary's contract (#feederLast, set at each election):
  // the fold is still that feeder's shard, and a delete queued for the reconnect must still be judged by
  // it (the stage-1 review's second pass: the live read alone said "no contract ⇒ local" and the lens
  // swallowed the delete). Undefined before the first primary, or from an old server that sends none.
  get feederContract()                     { return this.primary !== null ? this.links.get(this.primary)?.contract : this.#feederLast }
  #feederLast         

  //! clientLinks — the admitted CLIENT links this node serves (maintained at HELLO/linkDown). The
  // tap-forward (write.ts inbound) iterates this set — one size check when a node serves no clients,
  // so the member hot path pays nothing (M5b).
  clientLinks = new Set      ()
  //! #covered — the client links that may hold a digest answer's cover (Link.torn / Link.inQueue): added where #answer
  // sets one, pruned lazily by indexInsert once both are null, and at linkDown. It keeps indexInsert's cover check to
  // the links that can need it, so an interior insert on a node with many idle clients pays one size check.
  #covered = new Set      ()
  //! resync (spokes only, 2026-09-06 — DECISIONS V4-5): a spoke's fold is a VIEW of its feeder's, never a
  // source. When the feeder's digest shows a lane tail BELOW ours, the cluster's truth moved under us
  // (records died with a server; a failover landed on a lagging feeder) — the fold resets, an empty r=1
  // digest asks the feeder for everything, and the feeder's r=0 reply (FIFO: after the suffix) completes
  // it: every cell held before that did not come back is removed downstream. `old` = the cells held at
  // the reset. Null when not resyncing. Survives a failover (the new primary's reply completes it).
  //! `q` (DESIGN-SCALE stage 2, 2026-10-10 — the A11 stale-reply finding, M10): the correlation id of the r=1 the
  // resync sent. Every r=1 a CLIENT sends carries a fresh `q` (#dq, monotone per node) and a server's r=0 toward a
  // client echoes the `q` of the r=1 it answers. The resync may end ONLY on a reply whose q ≥ this one — the reply
  // to a digest sent AFTER the resync began (the failover's own r=1 counts, so a feeder that dies mid-resync is no
  // hang). A reply to an older digest — the failover's r=1 that the feeder's own digest crossed — is NOT the end:
  // before, it ran the ghost sweep before the re-download, and the re-download then landed one record run per
  // frame, so the screen went back in time. What that older reply's ship brought STAYS in the fold: it is the
  // feeder's committed log, the re-download re-sends it and the lane drops the duplicates (the client leg of the
  // dual fence, write.ts #splice); a second wipe would drop cells the screen still shows and the sweep does not
  // know. But kept, those records RAISE the lane tails this node holds, and on a wiped fold a raised tail has
  // nothing under it — so while in resync every digest this node sends announces d = {} (#sendDigest): "send me
  // everything", the lane drops what it has. A reply with no `q` is an older server's (V4-14): it ends as before.
  //! One ask per resync (the second review of stage 2, 2026-10-10; its premise corrected at the third re-check and
  // made true on 2026-10-11). In resync every digest this node sends says d = {}, so every ask costs the feeder a ship
  // of its whole held subset — and the ask's reply is the end. On this FIFO link the feeder answers the ask in the step
  // that handles it. An answer whose ship meets a full paused queue STOPS there and resumes at the feeder's drain with
  // its reply after the whole ship, and an answer whose frames or reply a later clear takes from the queue (a live
  // tap-forward, the drain digest) resumes from its first queued frame (#answer, Link.inQueue): the answer stays
  // resumable until its reply has left the queue, so a torn ship or a cleared reply is a late reply, never a missing
  // one. So the ONLY way a live feeder leaves an ask unanswered is the ask arriving while its link is paused
  // (swallowed: the paused branch of the DIGEST handler marks the debt and ships nothing). The feeder knows that, and
  // says so on its drain digest (`h: 1`, #sendDigest; a clear sets the same debt, and that digest follows the resumed
  // reply, when this node is out of resync and answers it with its real tails). So in resync this node (1)
  // sends no heartbeat floor to its primary (the ask IS the floor), (2) answers a feeder's r=1 that carries `h: 1`
  // with an r=1 of its own (a fresh q): that exchange ships everything and its reply ends the resync, one exchange
  // after the drain, and (3) answers any other r=1 from the feeder with NOTHING — it was sent before the feeder
  // handled the ask (its heartbeat floor crossing the ask at a failover), the reply is behind it, and an r=0 of ours
  // would say d = {} and buy a second ship. A feeder that dies instead is a failover, and that asks afresh. Before
  // this rule the spoke re-asked on a tick-age proxy (its own floor every tick; a feeder's r=1 once the ask was a tick
  // old): one ship on a normal link, but ceil(RTT / heartbeat) + 1 ships on a link slower than one heartbeat (the
  // review measured 5 and 9 at 200 ms each way with a 50 ms heartbeat, one ordering each); now one on any link.
  resync                                         = null
  #dq = 0

  //! feederScoped (DESIGN-SCALE stage 2) — is the cluster this spoke follows SCOPED? Read off the feeder's HELLO
  // contract (`replicas=N`, N > 0; the api spells it, kernel/node.ts appends `;ring=`), the last primary's when none
  // is up (feederContract). A scoped feeder shows a spoke only the partitions it holds and each holder's copy of a
  // lane is sparse, so at a failover the spoke's lane tails say nothing about what the NEXT feeder holds below them:
  // it resyncs onto the new feeder instead of asking for the suffixes above its tails. False with no contract (an
  // unscoped cluster, an old server, the sim's unscoped clusters): the failover digest carries the real tails.
  get feederScoped()          {
    const c = this.feederContract
    if (c === undefined) return false
    const m = /(?:^|;)replicas=(\d+)(?:;|$)/.exec(c)
    return m !== null && Number(m[1]) > 0
  }

  //! hosts — the discovery targets: static NodeOpts.hosts ∪ the dynamic set the `discover` event
  // installs (V4-3), deduplicated, minus this node's own listen. Genesis (links ≥ hosts) and the
  // revival loop read it every heartbeat, so it is CACHED — rebuilt only when either set (or the
  // listen) changes; the per-tick readers allocate nothing.
  #dynamic           = []
  #hostsCache                  = null
  get hosts()           {
    if (this.#hostsCache === null) {
      const out = new Set        ()
      for (const h of this.#opts.hosts ?? []) if (h !== this.listen) out.add(h)
      for (const h of this.#dynamic) if (h !== this.listen) out.add(h)
      this.#hostsCache = [...out]
    }
    return this.#hostsCache
  }

  //! dialing — is a backoff chain still actively trying this target? Membership holds eviction while
  // true: an un-exhausted dial means reachability is UNKNOWN (e.g. the pending-redial window right
  // after a heal), and evicting then is churn a one-tick wait avoids. Give-up ends the hold.
  dialing(to        )          {
    const b = this.#backoff.get(to)
    return !!b && !b.gaveUp && !b.parked
  }

  //! #revivable — the give-up revival target set: static hosts ∪ committed-view member listens (a
  // joiner learned via a VIEW is as entitled to revival as a configured host — it may OWN partitions).
  // The value says whether the target is a committed member's listen: a revived MEMBER keeps the
  // member chain (see the revive loop), a plain host gets the generic one.
  #revivable()                       {
    const targets = new Map                 ()
    for (const h of this.hosts) targets.set(h, false)
    for (const [u, listen] of this.membership.view.members) if (u !== this.uuid && listen) targets.set(listen, true)
    return targets
  }

  //! #held — a live link already reaches `to`: one I dialed there, or one whose peer PROVED (or, on the open
  // path, claimed at admit) that listen. Facts this node owns, never a closing peer's unproven claim. The
  // revive loop's rule (a held target is not re-dialed into a dup race), shared with linkDown's
  // close-while-proving case.
  #held(to        )          {
    for (const l of this.links.values()) if (!l.dead && (l.to === to || l.listen === to)) return true
    return false
  }

  //! step — the single dispatch site. Unknown event kinds fail closed (throw): an unrecognised stimulus is a harness bug, never something to guess at.
  step(e       ) {
    if (this.destroyed) return
    const j = this.journal
    switch (e.kind) {
      case 'start': {
        j.armed && j.emit(JK.start)
        //! M6: a RESTORED armed node classifies its replayed data before the network exists — held vs
        // orphan derives from (boot record ∪ restored ring ∪ the frozen orphanParts half), the C10
        // rule the replay held-gate used
        if (this.armed) this.scope .rescope(this)
        //! restored dirtyParts arm the snapshot swap immediately (M6-review finding 54): the dirty
        // ledger's only clear site is a snapshot echo, and nothing else would schedule one — the
        // floors stayed pinned at 0 and the ledger persisted forever.
        if (this.durable && this.#dirty.size) this.#walRows = this.tune.snapshotAt
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
        const next = new Set        ()
        for (const h of e.hosts) if (h && h !== this.listen) next.add(h)
        const prev = new Set(this.#dynamic)
        this.#dynamic = [...next]
        this.#hostsCache = null
        const statics = new Set(this.#opts.hosts ?? [])
        const covered = (to        )          => {
          for (const l of this.links.values()) if (!l.dead && (l.to === to || l.listen === to)) return true
          return false
        }
        for (const to of prev) {
          if (next.has(to) || statics.has(to) || this.membership.view.members.some(([, l]) => l === to)) continue
          for (const [id, m] of this.#timers) if (m.tag === TAG.redial && m.to === to) { this.#timers.delete(id); this.env.sink.cancel(id) }
          if (covered(to) || this.dialing(to)) this.#backoff.set(to, { ms: this.#opts.redialMs ?? 100, tries: this.tune.redials, gaveUp: true, parked: true })
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
              const st = this.scope .entries.get(p)?.state
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
              const st = this.scope .entries.get(p)?.state
              if (st !== SCOPE.held && st !== SCOPE.orphan) continue
              const pe = d.part(p)
              const cap = Math.min(s, pe.s)
              if (cap > pe.d) pe.d = cap
            }
          }
          let cleared = false
          const sealedNow           = []
          for (const [p, n] of snap.clears) if (this.#dirty.get(p) === n) { this.#dirty.delete(p); cleared = true; sealedNow.push(p) }
          if (cleared) this.persistBoot()
          //! the SEAL (findings 19/37/46): a dirty-clear proves the disk restores this partition's
          // whole base — a pending ACQDONE attestation gate opens now (announce + boot-list re-entry)
          for (const p of sealedNow) this.scope .sealed(this, p)
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
        const link = new Link(e.link, e.dialed, e.to, this.tune.queued)
        this.links.set(e.link, link)
        j.armed && j.emit(JK.linkUp, e.link, e.dialed ? 1 : 0)
        //! both sides open with HELLO — identity first, before anything routes. Clients declare the
        // role (r:1) so the peer excludes them from genesis and feeds them by tap-forward (M5b).
        // `n` (v4.1) declares the RESOURCE, only when configured — absent keys keep the frame
        // byte-identical with v4.0 (the sim's byte-identical sweep contract rides on that). `c` is the
        // cluster contract and `m: 1` the methods-only hint (DESIGN-DOOR §2): user-resource servers
        // only. `k` (§3) is my nonce for this link, minted by the door and kept on the Link — only when
        // this node has a door. Keys spread in only when present, in the order u, i, l, r, n, c, m, k.
        // With a door the sent object is kept (link.said): my proof signs exactly these keys.
        const door = this.door
        if (door !== undefined) link.nonce = door.nonce()
        const body            = {
          u: this.uuid, i: this.incarnation, l: this.listen,
          ...(this.client ? { r: 1 } : {}),
          ...(this.name !== undefined ? { n: this.name } : {}),
          ...(this.contract !== undefined ? { c: this.contract } : {}),
          ...(this.methodsOnly ? { m: 1 } : {}),
          ...(door !== undefined ? { k: link.nonce } : {}),
        }
        if (door !== undefined) link.said = body
        link.ship(encodeControl(VERB.HELLO, body), this.env.sink, j)
        return
      }
      case 'bytesIn': {
        const link = this.links.get(e.link)
        if (!link || link.dead) return // raced close — ids are never reused, so late chunks are safely ignored
        link.quiet = 0 // heard from (watchClients): one field store per chunk
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
        if (link.proveTimer !== -1) this.#unprove(link)
        if (this.byUuid.get(link.uuid) === e.link) this.byUuid.delete(link.uuid)
        this.clientLinks.delete(link)
        this.#covered.delete(link)
        //! a bare close while PROVING — before or after my proof — is a LINK LOSS, not a refusal (DESIGN-DOOR
        // §3, settled at the third review): the door speaks only through DOOR {e}, and a peer that refused
        // me sent one. A crash, a cut or a reset mid-handshake looks exactly like this close, and with
        // heartbeats off a park here stranded honest pairs and clients for good (41 of 480 cut-while-forming
        // pairs, 68 of 210 clients). So: no row, no park, and the ordinary bounded redial chain below — the
        // same one a link that died before HELLO gets. EXCEPT when the target is already HELD over another
        // live link (the keeper rule of a crossing dial: the peer admitted me there and closed this one as
        // the duplicate; its proof may still be in flight behind the close): then there is nothing to
        // redial. Held is judged on facts this node owns — a live link's proven listen or my own dial
        // target — never on the uuid the closing peer CLAIMED, which it never proved (the third review's
        // nit: a stranger at a typed host claiming a held member's uuid was never dialed again).
        const held = link.state === LS.proving && link.dialed && link.to !== undefined && this.#held(link.to)
        //! M6: a dying teacher aborts every latch it was feeding (window 6 — the buffer drops whole,
        // nothing folded, the next handshake round re-offers from a surviving holder)
        if (this.armed && link.uuid) this.scope .linkDown(this, link.uuid)
        //! client primary failover (M5b): the feeder died — elect the next admitted server, digest it
        // (its suffix ship resumes every origin lane from our announced tails, in order), and re-park
        // the in-flight attempts so the write drain re-targets the new relay NOW, not at RETRY_TICKS.
        if (this.client && this.primary === e.link) {
          this.primary = null
          this.feederOpen = null
          //! the dead feeder's taps die with it (wave 5e): every attempt its WACK cleared whose record has not
          // landed here is marked; the resync onto the next feeder settles what that feeder's ship does not bring
          this.writes.strand()
          for (const l of this.links.values())
            if (l.state === LS.admitted && !l.dead) { this.primary = l.id; this.#feederLast = l.contract; break }
          if (this.primary !== null) {
            //! a SCOPED feeder (feederScoped, DESIGN-SCALE stage 2): the new feeder holds a different subset, and its
            // copy of a lane this spoke learnt from the old one may run BELOW the spoke's tail (another partition's
            // rows), so an ask for the suffixes above the tails would miss them, and rows the new feeder does not
            // hold would stay on the screen. The spoke resyncs onto it: wipe, ask for everything, sweep the ghosts
            // at the end. An unscoped feeder holds every lane in full: the tails ask for exactly what is missing.
            if (this.feederScoped) this.#resyncBegin(this.links.get(this.primary) )
            else this.#sendDigest(this.links.get(this.primary) , 1)
            this.writes.repark(this)
          }
        }
        //! BOTH sides redial a lost peer (jittered capped backoff) — the dialer via its target, the
        // acceptor via the peer's gossiped listen. The acceptor-side chain is what arms the eviction
        // dialing-hold symmetrically (review: a 3-tick blip once evicted a live member from the acceptor
        // side, which held no chain) — crossing dials collapse via the one-link-per-pair dedup as usual.
        // Deliberate closes (dup-link/self-reject) never redial: that would just re-create the race.
        //! a lost ADMITTED MEMBER link is a crashed member: its chain is the short one (tune.memberRedials), because
        // eviction is held while this chain runs — see MEMBER_REDIALS. A link that died before HELLO is not.
        // Nor is anything a CLIENT dials: a client evicts nobody, so its chain is no clock, and with
        // heartbeats off a short chain would strand it from a restarting server (review finding).
        const redialTo = link.noRedial || held ? '' : link.dialed ? link.to ?? '' : link.listen
        if (redialTo) this.#redial(redialTo, !this.client && link.state === LS.admitted && this.membership.isMember(link.uuid))
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
        //! a TORN answer resumes FIRST (the third re-check of DESIGN-SCALE stage 2; its costs fixed 2026-10-11): the
        // suffix ship that stopped at a full queue goes on from where it stopped (or from its first queued frame, when a
        // clear took that frame since), and its reply follows the whole ship — so the peer's tails never rise above a
        // hole, and a spoke in resync ends on the reply with every row (see #answer). The flush above may have filled the
        // socket again (the shell steps `pause` inside a send): then the resume, the exchange and the round all wait for
        // the next drain. A resume that stops again likewise leaves the exchange for the drain that completes it — the
        // ask it carries would otherwise go out AHEAD of the rest of the ship and buy a spoke in resync a second download.
        if (link.torn !== null) {
          if (link.paused) return
          const t = link.torn
          link.torn = null
          this.#answer(link, t.d, t.r, t.q)
          if (link.torn !== null) return
        }
        //! drop-under-backpressure (or a digest swallowed while paused) left the peer with a tail hole in our stream —
        // follow the drain with a digest exchange so the loss heals within two round-trips instead of lingering until the
        // next admit. Never into a FULL queue (the resume can end with its tail and reply filling it): that digest would
        // clear the very reply it follows — the debt stays, and the next drain sends it.
        if (link.droppedWhilePaused && link.state === LS.admitted && !(link.paused && link.queued.length >= link.maxQueued)) {
          link.droppedWhilePaused = false
          //! toward a member (armed): it re-syncs the link and ships nothing — the round below repairs. Toward a CLIENT it
          // says `h: 1`: this link dropped frames, so a spoke whose resync ask got no reply asks again (see `resync`)
          this.#sendDigest(link, 1, undefined, true)
        }
        //! the DRAIN ROUND (DESIGN-SCALE stage 2, §3 trigger 2): every announcement skipped this link while it was
        // paused (kernel/scope.ts #link), so the one scoped round to this peer, for the partitions the two share,
        // is what catches it up — whether or not its queue dropped (a deviation from the row's "whose queue
        // dropped", with that reason). The peer that finds itself behind latches us; a lost record re-ships once.
        if (this.armed && !link.client && link.state === LS.admitted) this.scope .round(this, new Set([link]))
        return
      }
      case 'timer': {
        const meta = this.#timers.get(e.id)
        if (!meta) return // cancelled — the raced fire is ignored by id, per the Env contract
        this.#timers.delete(e.id)
        if (meta.tag === TAG.redial && meta.to) { j.armed && j.emit(JK.dial, meta.to); this.env.sink.connect(meta.to) }
        //! the proving deadline (DESIGN-DOOR §3): the peer's HELLO carried `k` and its DOOR never came —
        // a stranger with a socket, a wrong-secret dialer that went quiet, a lost frame. A link that has
        // moved on (admitted, dead, gone) is left alone: the fire is stale by then.
        else if (meta.tag === TAG.prove) {
          const link = meta.link !== undefined ? this.links.get(meta.link) : undefined
          if (link === undefined || link.dead || link.state !== LS.proving) return
          link.proveTimer = -1
          j.armed && j.emit(JK.doorReject, link.id, 'timeout', link.to ?? '')
          this.#refuse(link, 'door-timeout')
        }
        else if (meta.tag === TAG.heartbeat) {
          //! watchClients: close every client link silent past the bound, then PING the rest of them below
          // (the PING is what makes silence mean something: a live client answers it within a round trip)
          const watch = this.#opts.watchClients ?? 0
          if (watch > 0)
            for (const link of this.links.values())
              if (link.client && !link.dead && link.state === LS.admitted && ++link.quiet > watch) {
                link.dead = link.noRedial = true
                this.env.sink.close(link.id, 'silent')
              }
          for (const link of this.links.values()) {
            //! a watched client link is PINGed from this side whatever the uuid order (no digest: the rule below)
            if (watch > 0 && link.client && !link.dead && link.state === LS.admitted && !link.paused && this.uuid > link.uuid) {
              link.ship(encodeControl(VERB.PING), this.env.sink, j)
              j.armed && j.emit(JK.ping, link.id)
            }
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
              // A client floors only its PRIMARY (the single-feeder rule — see the DIGEST handler), and not
              // while in RESYNC: the resync's ask is the floor, every digest sent in resync asks for everything,
              // and only the feeder's drain digest can mean the ask needs re-sending (see `resync`).
              //! On a SCOPED cluster the member floor does not run (DESIGN-SCALE stage 2, §3; the owner's yes,
              // §14 Q1): a member learns history only through the one-teacher latch, and the holder handshake
              // — announce on change, the admit and drain rounds, the aeFan sweep (kernel/scope.ts tick) — is
              // what re-proves every pair. The digest to a CLIENT link is unchanged: a spoke floors on it.
              if ((!this.client || (link.id === this.primary && this.resync === null)) && !(this.armed && !link.client)) this.#sendDigest(link, 1)
            }
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
          if (this.armed) this.scope .tick(this)
          //! the WAL snapshot (M4e) arms AFTER compaction so the swap captures the just-compacted log
          if (this.durable && this.#walRows >= this.tune.snapshotAt) this.snapshot()
          //! give-up revival: a target whose final redial attempt FAILED (gaveUp — never merely "tries
          // exhausted": the last armed attempt may still be pending, and dialing over it would fork a
          // second chain) is parked, not dead — each heartbeat re-dials any parked target we hold no link
          // to, with a fresh backoff chain (the M1 re-announce floor; full UDP discovery lands with
          // L0-complete). Targets are the static hosts PLUS the committed view's member listens
          // (adversarial-review wedge: a view-learned member — a joiner never in `hosts` — whose chain
          // gave up was parked FOREVER, stranding every attempt owner-routed to it). A live link to the
          // target — including one the PEER dialed — clears the stale give-up instead of dialing into a
          // dup race.
          //! a revived COMMITTED MEMBER keeps the member chain: the entry is re-seeded `member` before the
          // dial, so the failed dial (which lands in the no-link linkDown path, which knows no link state)
          // continues a short chain, not a fresh long one. Otherwise, when the member chain ends before
          // suspicion (three heartbeats longer than about 31 × redial.ms — heartbeat.ms 2000 at the
          // default base, or redial.ms 30 at the default heartbeat), the revival would hold eviction for
          // ten more tries — slower than before the short chain existed (review finding). A client's
          // chain is never a clock (see linkDown), so a client revives with the generic chain.
          for (const [to, member] of this.#revivable()) {
            if (to === this.listen) continue
            if (!this.#backoff.get(to)?.gaveUp) continue // never failed, or the redial chain still owns it
            const held = this.#held(to)
            this.#backoff.delete(to)
            if (held) continue
            if (member && !this.client) this.#backoff.set(to, { ms: this.#opts.redialMs ?? 100, tries: 0, member: true }) // the dial in flight — visible to a park, like discover's
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
        const never        = e
        throw new Error(`unknown event ${(never                    ).kind}`)
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
  commit(recs       , attempt             )         {
    const j = this.journal
    //! the clock lease: stamping past the durable ceiling re-persists the boot record FIRST (sink.boot
    // is synchronous by contract), so a crash at ANY instant restores to a ceiling no stamp ever passed
    if (this.durable && this.seq + recs.length > this.#seqCeiling) this.persistBoot()
    const s0 = this.seq + 1
    for (let k = 0; k < recs.length; k++) {
      const rec = recs[k]
      const seq = ++this.seq
      const entry                                                                                    = { rec, seq, epoch: this.epoch }
      if (attempt) { entry.iss = attempt.issuer; entry.cid = attempt.baseCid + k }
      //! M6 pp (the floor law): the stamping owner is the ONE party that knows this (origin,
      // partition) sub-stream's predecessor — lastStamp, fed on EVERY scoped commit INCLUDING epoch
      // 0 (the panel's seam hole: an armed-gated feed would stamp the first post-arming commit
      // pp=0, forging first-ever over the genesis history) and NEVER cleared by shed (the
      // shed-then-reassigned-same-life window would re-forge pp=0; restarts rebirth the lane, so a
      // fresh map is truthful). Memory-only — unscoped nodes never touch it (byte-identity).
      let pp                    
      if (this.scoped) {
        const p = partitionOf(rec)
        pp = this.lastStamp.get(p) ?? 0
        this.lastStamp.set(p, seq)
        if (this.armed) entry.pp = pp
      }
      this.logFor(this.origin).push(entry) // the record is OWNED from here (embedder hands it over)
      this.indexAppend(this.origin, entry)
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
      let holders                           = null
      if (this.armed) {
        const p = partitionOf(rec)
        const pe = d.part(p)
        //! the floor advanced at the stamp site: the ONE dirty mark of the hot path (DESIGN-SCALE stage 2) — the next
        // tick announces the new floor to p's co-holders in one batched HAVEQ per link (kernel/scope.ts `dirty`)
        if (pp  <= pe.s && seq > pe.s) { pe.s = seq; this.scope .dirty.add(p) }
        this.scope .mintHeld(this, p) // the owner holds what it stamps — the entry exists from the first commit
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
      let parts                                 
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
  persistRun(origin        , maxSeq        , bytes            , parts                      ) {
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
    const rows                                        = []
    const tails = new Map                ()
    for (const [origin, entries] of this.logs) {
      if (!entries.length) continue
      let prev = 0
      let i = 0
      while (i < entries.length) {
        const h = entries[i]
        let j = i + 1
        while (j < entries.length && j - i < 1024 && entries[j].epoch === h.epoch && entries[j].seq === h.seq + (j - i) &&
               entries[j].iss === h.iss && (h.iss === undefined || entries[j].cid === h.cid  + (j - i))) j++
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
      const floors = new Map                             ()
      for (const [origin, d] of this.streams) {
        if (!d.parts?.size) continue
        const per = new Map                ()
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
  condemn(origin        ) {
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
    this.byPart?.clear()
    this.tombs?.clear()
    this.state.clear()
    this.versions.clear()
    this.deep.clear()
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
  //! Begun MID-RESYNC (a scoped failover onto a third feeder while the second's re-download was landing): the cells
  // held at the FIRST reset stay in `old` — the screen still shows them, and only this set is swept at the end — and
  // the partial re-download's cells join it; the fold is wiped again (the new feeder's held subset is the truth).
  #resyncBegin(link      ) {
    const old = this.resync !== null ? this.resync.old : new Set        ()
    for (const k of this.state.keys()) old.add(k)
    this.journal.armed && this.journal.emit(JK.resync, old.size)
    this.#resetFold()
    const q = ++this.#dq
    this.resync = { old, q }
    this.#sendDigest(link, 1, q)
  }

  //! #resyncEnd — the feeder's reply arrived: every cell held at the reset that the re-download did not
  // bring back is a GHOST — removed downstream through the ordinary apply effect (a synthesized remove
  // under this node's own name, seq 0: never logged, never on the wire; a still-pending own write on
  // that cell shows again when its stamped echo arrives, exactly as after any foreign remove — V4-7).
  // Across depth (V4-18): a ghost FIELD is covered when its row (or any ancestor) is LIVE now — the
  // re-download applied the whole row, which is the truth, and a remove here would tear a field out of
  // it — or was held at the reset and is a ghost itself: its remove takes the field with it. A ghost
  // ROW whose newer fields came back has erased them downstream: they go back on top, as after a sweep.
  #resyncEnd() {
    const { old } = this.resync 
    this.resync = null
    let ghosts = 0
    for (const cell of old) {
      if (this.state.has(cell)) continue
      const path = JSON.parse(cell)            
      if (path.length > 1) {
        let covered = false
        for (let d = 1; d < path.length && !covered; d++) {
          const a = JSON.stringify(path.slice(0, d))
          covered = this.state.has(a) || old.has(a)
        }
        if (covered) continue
      }
      ghosts++
      this.env.sink.apply({ type: REC.remove, key: path, origin: this.uuid, seq: 0, epoch: 0 })
      const back = this.#under(cell)
      if (back.length) this.#reapply(back)
      if (path.length > 1) this.#unvivify(path, ancestorsOf(path))
    }
    this.journal.armed && this.journal.emit(JK.resynced, ghosts)
    //! the new feeder's ship has landed: a write the dead feeder WACKed and never tapped either folded in it (the
    // join settled it, after its value showed) or will not come from here — it settles from its WACK (wave 5e)
    this.writes.settleStranded(this)
  }

  //! persistBoot — (re)write the durable boot record: the committed view, the Lamport CEILING (the
  // lease — see LAMPORT_LEASE), the incarnation, and the SPENT ballot identity (a vote must be durable
  // before the VOTE frame leaves — membership calls this before shipping; the env's boot() contract is
  // write-before-later-sends).
  persistBoot() {
    if (!this.durable) return
    const m = this.membership
    this.#seqCeiling = this.seq + this.tune.lamportLease
    this.env.sink.boot({
      //! identity rides the record (v4.1): restore recovers WHO this dir belongs to, so an omitted
      // config uuid can never half-restore under a fresh random identity (the silent evicted-heir
      // bug) — and WHAT it replicates, so a dir pointed at by the wrong resource refuses loudly.
      uuid: this.uuid,
      ...(this.name !== undefined ? { name: this.name } : {}),
      epoch: m.view.epoch,
      members: m.view.members.map((x) => [x[0], x[1]]                    ),
      lamport: this.#seqCeiling,
      incarnation: this.incarnation,
      votedFor: { ...m.votedFor },
      //! M6 (armed only — unscoped boot bytes stay byte-identical): the dirty-partition ledger, the
      // data-authoritative held-set (a mid-latch entry rides under its PRE-latch classification;
      // the staged buffer itself is memory-only — C10 as amended by the review), the FROZEN orphan
      // half (finding 48), and the floor seed (the pp chain-rebuild's base — a stale seed is
      // honest-low, and replay advances from it through the WAL rows).
      ...(this.armed && this.#dirty.size ? { dirtyParts: [...this.#dirty.keys()] } : {}),
      ...(this.armed ? { heldPartitions: this.scope .heldList(), orphanParts: this.scope .orphanList(), floors: this.#floorSeed() } : {}),
    })
    this.journal.armed && this.journal.emit(JK.bootWrite, m.view.epoch, m.votedFor.e)
  }

  //! #floorSeed — the boot record's floor snapshot: per (origin, partition) [possession, durable].
  #floorSeed()                                                   {
    const out                                                   = {}
    for (const [origin, d] of this.streams) {
      if (!d.parts?.size) continue
      const per                                   = {}
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
    this.env.sink.timer(id, TAG.heartbeat, this.#opts.heartbeatMs )
  }

  //! #redial — jittered capped exponential backoff per target, BOUNDED attempts; jitter comes from env.rng so trajectories stay seed-reproducible.
  // The give-up after MAX_REDIALS is what keeps a refused target from keeping the
  // sim's event queue (and a real process's timer wheel) alive forever; it is
  // journal-visible, and the heartbeat tick revives a given-up target (so with
  // heartbeats on, one exhausted chain re-arms per heartbeat interval, bounded).
  // A successful identify resets the counter. `member` asks for a crashed member's chain (the short
  // cap, tune.memberRedials): anything else pointed at the target gives way to it; a member chain keeps going.
  #redial(to        , member = false) {
    if (this.destroyed) return
    const base = this.#opts.redialMs ?? 100
    const t = this.tune
    const cur = this.#backoff.get(to)
    let b = cur ?? { ms: base, tries: 0, member }
    //! a PARKED target (discover forgot it while a link/dial still named it): the chain ends here and
    // the entry goes with it — no timer, no revival, nothing left to grow (#backoff stays bounded by
    // the live link set, not by every address a port-0 server ever had)
    if (b.parked) { this.#backoff.delete(to); return }
    //! a dead MEMBER's chain is ALWAYS the member chain (V4-20's clock). Whatever else is pointed at the
    // target when the member link dies is not that chain: a timer an identify orphaned (the identify
    // deletes the entry, not the timer — up to 32 × base away), or a GENERIC chain a stray dial started
    // while the member link was still up (on the open path the peer closes my duplicate dial before I
    // identify it). Letting that one own the target delayed the eviction by up to 3.2 s, or brought back
    // the 10-try chain and the 20 s eviction (review, 2026-10-09). So: cancel it and start the member
    // chain fresh, at the base delay. A chain that is ALREADY the member chain is never restarted (the
    // rule below: a second linkDown arms nothing) — restarting it would lengthen it.
    if (member && !cur?.member) {
      for (const [id, m] of this.#timers) if (m.tag === TAG.redial && m.to === to) { this.#timers.delete(id); this.env.sink.cancel(id) }
      b = { ms: base, tries: 0, member: true }
    }
    //! a timer already pending toward this target OWNS it (the view install's rule, membership.ts): a
    // second linkDown naming the same address — the dialed link's `to` and the accepted link's gossiped
    // listen when a crossing pair is cut, a late refused dial — arms nothing. It used to arm a second
    // timer line on the same entry, and the two lines shared the tries, so the chain (and the eviction
    // hold it carries) gave up in about half its time; at the cap it marked the target given up while
    // the final attempt was still pending, and the revival dialed over it. One chain, its own tries.
    //! a call that finds an orphaned timer (no entry: an identify reset the chain) writes the entry, so
    // dialing() holds while that timer is out; when its dial fails, the chain's tries arm from tries 0.
    // Since the member rule above, only a NON-member linkDown gets here: the entry keeps the view install
    // (membership.ts) from dialing over the orphan, a crossing dial on a live peer.
    else for (const m of this.#timers.values()) if (m.tag === TAG.redial && m.to === to) {
      if (!cur) this.#backoff.set(to, b)
      return
    }
    if (b.tries >= (b.member ? Math.min(t.memberRedials, t.redials) : t.redials)) {
      //! the final ARMED attempt has now FAILED — only here does the target become truly parked
      if (!b.gaveUp) {
        b.gaveUp = true
        this.#backoff.set(to, b)
        this.journal.armed && this.journal.emit(JK.giveUp, to)
      }
      return
    }
    this.#backoff.set(to, { ms: Math.min(b.ms * t.redialGrowth, base * t.redialCap), tries: b.tries + 1, member: b.member })
    const delay = b.ms + Math.floor(this.env.rng() * base)
    const id = ++this.#timerSeq
    this.#timers.set(id, { tag: TAG.redial, to })
    this.env.sink.timer(id, TAG.redial, delay)
    this.journal.armed && this.journal.emit(JK.redial, delay, to)
  }

  //! #admit — the admit tail (DESIGN-DOOR §3 steps 12-13): the role rule, the duplicate-link rule, admit.
  // Reached by a HELLO on an OPEN node (nothing to prove) and by a verified DOOR on a secured one, with
  // the HELLO the link stashed. From here on the HELLO is trusted: with a door it has proved itself;
  // without one, loopback is the trust boundary (V4-3).
  #admit(link      , v           ) {
    const j = this.journal
    const { r, m } = v
    //! the role rule (DESIGN-DOOR §3 step 12; with or without a secret). A CLIENT HELLO (r:1) may not
    // take a MEMBER's uuid: #uuidTaken refuses THIS link and touches nothing else — the member's link
    // stays up and no dupLink row is written, so a stray FERO_UUID in a client's shell can no longer
    // knock a member off its peer (the STATUS case). On a secured node that check already ran BEFORE
    // this node's proof left (the DOOR handler), so here it is a no-op there. The reverse: a non-client
    // HELLO whose uuid an admitted CLIENT link holds evicts that client link (the row names the
    // client's link) and continues into admit — a client was never entitled to the uuid. Two client
    // links with one uuid fall through to the duplicate-link rule as before.
    if (this.#uuidTaken(link, v)) return
    let existingId = this.byUuid.get(v.u)
    {
      const squatter = existingId !== undefined && existingId !== link.id ? this.links.get(existingId)  : undefined
      if (r !== 1 && squatter !== undefined && squatter.client) {
        j.armed && j.emit(JK.doorReject, existingId , 'uuid-taken', v.u)
        squatter.dead = squatter.noRedial = true
        this.env.sink.close(existingId , 'uuid-taken')
        existingId = undefined // admit below; the evicted link's linkDown echo sees byUuid pointing at the new link and leaves it
      }
    }
    if (existingId !== undefined && existingId !== link.id) {
      const existing = this.links.get(existingId) 
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
    if (r === 1) { link.client = true; this.clientLinks.add(link) }
    link.methodsOnly = m === 1 // the hint (§4): a client reads it live off its primary (feederMethodsOnly)
    if (typeof v.c === 'string') link.contract = v.c // the contract as sent: a client reads it live off its primary (feederContract)
    link.state = LS.admitted
    if (link.proveTimer !== -1) this.#unprove(link) // the door is behind us: the deadline and the stash go (step 13)
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
      if (this.primary === null) {
        this.primary = link.id; this.#feederLast = link.contract
        //! a SCOPED feeder elected HERE (the last one died with no other link up, so the linkDown arm found nobody) is
        // the failover's second path, and the same shape (DESIGN-SCALE stage 2; the review's test found it): this
        // spoke's lane tails came from a feeder that held a different subset, so an ask with them would miss what this
        // one holds below them and leave what it does not hold on the screen. It resyncs onto this feeder too —
        // whenever it holds anything, or a resync is already open (a mid-resync death: the sweep set must union, as in
        // the linkDown arm). A spoke that holds nothing yet asks its first feeder as before: bytes unchanged.
        // A spoke with stranded writes (wave 5e: WACKed by the dead feeder, never tapped) resyncs too, even with an
        // empty fold: the resync's end is where they settle.
        if (this.feederScoped && (this.resync !== null || this.logs.size > 0 || this.writes.stranded)) this.#resyncBegin(link)
        else this.#sendDigest(link, 1)
      }
    } else if (!link.client && this.uuid < link.uuid) this.#sendDigest(link, 1)
    //! view-on-admit (from BOTH ends, unlike the digest): announce the committed view so a healed peer's
    // membership converges even when no epoch-stamped records flow; then settle — an admitted member
    // can flip the gate back to majority, flushing any parked writes
    this.membership.onAdmit(this, link)
    this.membership.settle(this)
    //! round-on-admit (M6-review findings 13/23/33/40/49 — DESIGN-M6 C3's mandated trigger): the
    // post-reconnect multi-source window creates interior holes suffix AE cannot fill (they sit
    // below the scalar lane tail), and a lost install-round offer otherwise re-heals only at the
    // next install. One batched HAVEQ per admit re-announces + re-probes, to the ADMITTED PEER only
    // for the partitions the two share (DESIGN-SCALE stage 2 §3 trigger 2; it used to be a full round
    // to every co-holder); it rides AFTER the VIEW frame on this same FIFO link (finding 39's ordering
    // rule), so a healed peer installs the epoch before judging the round's epoch stamp.
    if (this.armed && !link.client) this.scope .round(this, new Set([link]))
  }

  //! #uuidTaken — the refusing half of the role rule (DESIGN-DOOR §3 step 12): a CLIENT HELLO (r:1) whose
  // uuid is a committed-view member's (isMember) or is held by an admitted NON-client link. Refuse this
  // link: doorReject 'uuid-taken', with a door the best-effort notice {e: 'uuid-taken'} (the peer is
  // proving and can read it; an open node ships nothing — zero new frames on the open path), dead +
  // noRedial, close. On a secured node it runs BEFORE this node's own proof leaves (the DOOR handler), so
  // the refused client is still proving when the notice or the close reaches it and journals `refused`
  // — it is never admitted on its own side first (the review's finding). True = refused, nothing else moved.
  #uuidTaken(link      , v           )          {
    if (v.r !== 1) return false
    const existingId = this.byUuid.get(v.u)
    const squatter = existingId !== undefined && existingId !== link.id ? this.links.get(existingId)  : undefined
    if (!this.membership.isMember(v.u) && (squatter === undefined || squatter.client)) return false
    const j = this.journal
    j.armed && j.emit(JK.doorReject, link.id, 'uuid-taken', v.u)
    if (this.door !== undefined) link.ship(encodeControl(VERB.DOOR, { e: 'uuid-taken' }), this.env.sink, j)
    link.dead = link.noRedial = true
    this.env.sink.close(link.id, 'uuid-taken')
    return true
  }

  //! #refuse — the door's refusal idiom (nameReject's, V4-3): dead + noRedial, and a DIALED target is parked
  // GIVEN-UP — never a redial chain (that would hammer a misconfigured or hostile port) — so the heartbeat's
  // give-up revival re-dials it once per heartbeat while it stays in hosts ∪ view: a fixed secret, a fixed
  // config or a resource that moves onto the right port heals at heartbeat cadence. The caller journals.
  #refuse(link      , reason        ) {
    link.dead = link.noRedial = true
    if (link.dialed && link.to) this.#backoff.set(link.to, { ms: this.#opts.redialMs ?? 100, tries: this.tune.redials, gaveUp: true })
    this.env.sink.close(link.id, reason)
  }

  //! #unprove — the proving deadline is over (admitted, or the link is gone): cancel its timer and drop the stash.
  #unprove(link      ) {
    this.#timers.delete(link.proveTimer)
    this.env.sink.cancel(link.proveTimer)
    link.proveTimer = -1
    link.hello = null
  }

  //! #dispatch — per-frame verb routing; fails closed (journal + drop) on unknown verbs so control can never fall into the data path.
  #dispatch(link      , f       ) {
    const j = this.journal
    switch (f.verb) {
      case VERB.HELLO: {
        const v = f.value                                             
        if (typeof v?.u !== 'string' || typeof v.i !== 'number' || typeof v.l !== 'string') {
          j.armed && j.emit(JK.frameDrop, link.id, 'malformed hello')
          link.dead = true
          return this.env.sink.close(link.id, 'malformed-hello')
        }
        //! M7 DIAG (DESIGN-M7 §1): an r:2 HELLO is a diagnostics ATTACH, not a peer — the whole machine
        // lives in kernel/diag.ts; this is the one branch the safety-critical HELLO path grows. Checked
        // BEFORE self-reject/dup-link so a diag client can never perturb byUuid or evict a member by
        // presenting a spoofed uuid; the LS.diag leg catches a re-HELLO on an already-latched session.
        if (link.state === LS.diag || (v                   ).r === 2) return diagHello(this, link, v                           )
        //! ── the pre-door checks (DESIGN-DOOR §3): shape → diag (above) → a second HELLO → name →
        // contract → self-reject → the secret matrix → the address rule. None of them touches shared
        // state (byUuid, #peerInc, clientLinks, membership); only a dialed target may be parked. Then
        // the proof (stash + DOOR, below), and only a proven HELLO — or any HELLO on an open node —
        // reaches #admit, the admit tail.
        //! a second HELLO (§3 step 3), secured nodes only: on a link already proving or admitted it would
        // replace the stashed nonce and break the proof, so it is dropped and the link lives (the dup
        // fault re-delivers HELLO; a close here would kill a healthy link). An OPEN node keeps today's
        // path — a duplicated HELLO re-runs the admit tail — because 14 of the 20 golden seeds re-admit
        // through the dup fault, and the golden must not move.
        const door = this.door
        if (door !== undefined && link.state !== LS.hello) { j.armed && j.emit(JK.frameDrop, link.id, 'hello twice'); return }
        //! resource-name refusal (v4.1): when BOTH ends declare a name and they differ, this link
        // reaches for a DIFFERENT resource — admit it and digest-on-admit would silently cross-
        // replicate two unrelated logs (a durable merge). Refuse loudly instead: dead + noRedial,
        // the same idiom as the self-reject below. One side declaring and the other not is the
        // legacy/embedder case — no check (absent means "no claim", never "any resource").
        const { n, c, m, r, k } = v                                                                       
        //! the optional keys' shape (§2): `n` a string, `c` a string of 1..256 chars, `m` exactly 1, `k` a
        // string of 16..64 chars — anything else is a malformed HELLO. An r:2 HELLO never reaches here.
        if ((n !== undefined && typeof n !== 'string')
          || (c !== undefined && (typeof c !== 'string' || c.length === 0 || c.length > 256))
          || (m !== undefined && m !== 1)
          || (k !== undefined && (typeof k !== 'string' || k.length < NONCE_MIN || k.length > NONCE_MAX))) {
          j.armed && j.emit(JK.frameDrop, link.id, 'malformed hello')
          link.dead = true
          return this.env.sink.close(link.id, 'malformed-hello')
        }
        if (typeof n === 'string' && this.name !== undefined && n !== this.name) {
          j.armed && j.emit(JK.nameReject, link.id, n)
          //! a DIALED target answering for another resource is parked GIVEN-UP (never a redial chain —
          // that would hammer a misconfigured port), so the heartbeat's give-up revival re-dials it
          // once per heartbeat while it stays in hosts ∪ view: a squatter on the rendezvous, or a
          // resource that moves onto the right port later, heals at heartbeat cadence instead of
          // stranding this node forever (V4-3 panel: noRedial alone never started a chain, so
          // revival — which keys on gaveUp — could never reach the target). #refuse is that idiom.
          return this.#refuse(link, 'name-mismatch')
        }
        //! the cluster contract (DESIGN-DOOR §4): when BOTH ends carry `c` and the link is not a client
        // link and the strings differ, the two servers run different cluster config (heartbeat.ms,
        // replicas, methods, the validation text, the ring) — a mismatch that used to show only as
        // behaviour. Refuse at the door and name the first key that differs (b) and THEIR value (c),
        // never ours; the nameReject idiom (dead + noRedial, a dialed target parked gaveUp so heartbeat
        // revival re-dials it once per heartbeat; a fixed value heals). One side absent → no check (a
        // client, the sim, an embedder). Runs AFTER the name check (a misdial reads nameReject) and
        // BEFORE the self-reject and the proof, so a config mistake never reads as a bad secret.
        if (typeof c === 'string' && this.contract !== undefined && r !== 1 && c !== this.contract) {
          const [key, theirs] = contractDiff(this.contract, c)
          j.armed && j.emit(JK.contractReject, link.id, key, theirs)
          return this.#refuse(link, 'contract-mismatch')
        }
        if (v.u === this.uuid) {
          //! self-reject by uuid — a gossip loop or misconfig dialled ourselves; never redial a self-loop
          j.armed && j.emit(JK.selfReject, link.id)
          link.dead = link.noRedial = true
          return this.env.sink.close(link.id, 'self')
        }
        const hello = v             
        //! the secret matrix (§3 step 7): I have a door and the peer sent no `k` → 'no-secret'; I have no
        // door and the peer sent `k` → 'peer-secret'. Both ends see the mismatch, so both refuse and
        // both print. The row's c is the dial target, or the listen the peer claimed.
        if ((door !== undefined) !== (k !== undefined)) {
          j.armed && j.emit(JK.doorReject, link.id, door !== undefined ? 'no-secret' : 'peer-secret', link.to ?? hello.l)
          return this.#refuse(link, 'door')
        }
        if (door !== undefined) {
          //! the address rule (§3 step 9, the relay): a DIALED target that is not one of my static hosts
          // came from the directory or a committed view — both carry the peer's own listen — so the
          // acceptor must claim exactly the address I dialed, or someone between us is answering for it.
          if (!addressOk(link, this.#opts.hosts, hello.l)) {
            j.armed && j.emit(JK.doorReject, link.id, 'address', hello.l)
            return this.#refuse(link, 'door')
          }
          //! stash and prove (§3 step 10): the HELLO waits on the Link, the link sits in `proving`
          // (outside byUuid, clientLinks and admitted(); every admitted-only verb closes it), and a
          // one-shot deadline is armed. The DIALER proves now; the acceptor proves back only once the
          // dialer's proof checked out (the DOOR handler) — a stranger that can only connect never
          // gets a proof to relay.
          link.hello = hello
          link.state = LS.proving
          const id = ++this.#timerSeq
          link.proveTimer = id
          this.#timers.set(id, { tag: TAG.prove, link: link.id })
          this.env.sink.timer(id, TAG.prove, this.tune.proveMs)
          if (link.dialed) {
            link.ship(encodeControl(VERB.DOOR, { p: prove(door, link, link.said , hello) }), this.env.sink, j)
            link.proved = true
          }
          return
        }
        //! neither side has a door (§3 step 8): the admit tail, as today, plus the role rule
        return this.#admit(link, hello)
      }
      //! DOOR (DESIGN-DOOR §3 step 11): the proof, or a refusal notice. Only a PROVING link may carry one:
      // before HELLO it is the write-before-hello shape (close); on an admitted link it is a DROP, not a
      // close, so the dup fault cannot kill a live link. A right-shaped proof that does not verify is
      // `bad-proof`: a best-effort {e:'denied'} goes out and the link closes, parked if I dialed it. A
      // proof that verifies ends the wait: the ACCEPTOR sends its own proof FIRST and then admits, so on
      // this FIFO link the dialer reads the proof before the digest and VIEW that admission ships; the
      // DIALER (which proved at HELLO time) just admits.
      case VERB.DOOR: {
        if (link.state === LS.hello) {
          j.armed && j.emit(JK.frameDrop, link.id, 'door before hello')
          link.dead = true
          return this.env.sink.close(link.id, 'door-before-hello')
        }
        if (link.state !== LS.proving) { j.armed && j.emit(JK.frameDrop, link.id, 'door out of order'); return }
        const v = f.value                                
        //! the peer's notice: it refused my proof, or my uuid. 'denied' and any unknown word read `refused`;
        // 'uuid-taken' carries a reason this side cannot guess (the uuid this process runs as belongs to a
        // member there — a shared FERO_UUID), so it keeps its word; c = the dial target either way. The
        // notice is the ONLY refusal a dialer can read: it is best-effort, and when it is lost the close
        // that follows is a link loss like any other (the ordinary redial chain, no row — linkDown; the
        // third review). Only a link I have PROVED on can be refused: a notice before my proof (an
        // acceptor that is still waiting for the dialer's proof) is out of order — a stranger's frame,
        // not a refusal — dropped and closed like a malformed DOOR, with no `refused` row.
        if (typeof v?.e === 'string') {
          if (!link.proved) {
            j.armed && j.emit(JK.frameDrop, link.id, 'notice before proof')
            link.dead = true
            return this.env.sink.close(link.id, 'malformed-door')
          }
          j.armed && j.emit(JK.doorReject, link.id, v.e === 'uuid-taken' ? 'uuid-taken' : 'refused', link.to ?? '')
          return this.#refuse(link, 'door')
        }
        if (typeof v?.p !== 'string' || v.p.length !== PROOF_LEN) {
          j.armed && j.emit(JK.frameDrop, link.id, 'malformed door')
          link.dead = true
          return this.env.sink.close(link.id, 'malformed-door')
        }
        const door = this.door , hello = link.hello 
        if (!verify(door, link, this.uuid, hello, v.p)) {
          j.armed && j.emit(JK.doorReject, link.id, 'bad-proof', link.to ?? hello.l)
          link.ship(encodeControl(VERB.DOOR, { e: 'denied' }), this.env.sink, j)
          return this.#refuse(link, 'door')
        }
        if (!link.dialed) {
          //! the role rule BEFORE my proof (step 12 ahead of step 11's second half): a verified client that
          // claims a member's uuid is refused while it is still proving, so it reads the notice as `refused`
          // and never admits this node on its own side first
          if (this.#uuidTaken(link, hello)) return
          link.ship(encodeControl(VERB.DOOR, { p: prove(door, link, link.said , hello) }), this.env.sink, j)
          link.proved = true
        }
        return this.#admit(link, hello)
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
        const v = f.value                           
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
        const v = f.value                                              
        if (typeof v?.id !== 'number' || typeof v.m !== 'string') {
          j.armed && j.emit(JK.frameDrop, link.id, 'malformed rpc')
          return
        }
        j.armed && j.emit(JK.rpcIn, f.verb, v.id, v.m)
        return this.env.sink.invoke(link.id, v.id, f.verb, v.m, v.a)
      }
      case VERB.UNSUB: {
        if (link.state !== LS.admitted) return
        const v = f.value                    
        if (typeof v?.id !== 'number') return
        j.armed && j.emit(JK.rpcIn, f.verb, v.id, '')
        return this.env.sink.invoke(link.id, v.id, f.verb, '', undefined)
      }
      case VERB.RESULT: {
        if (link.state !== LS.admitted) return
        const v = f.value                                               
        if (typeof v?.id !== 'number') return
        j.armed && j.emit(JK.rpcAnswer, v.id, v.ok === 1 ? 1 : 0)
        return this.env.sink.result(v.id, v.ok === 1, v.v, false) // a wire RESULT — a handler's reply, never a local failure
      }
      case VERB.SUBREC: {
        if (link.state !== LS.admitted) return
        const v = f.value                                    
        if (typeof v?.id !== 'number' || !Array.isArray(v.recs)) return
        return this.env.sink.subRecs(v.id, v.recs         ) // deliberately un-journaled: per-delta volume
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
        const v = f.value                                                                                                                
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
              const dur = typeof v.p?.[origin] === 'number' ? (v.p[origin]          ) : 0
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
            const dur = typeof v.p?.[origin] === 'number' ? (v.p[origin]          ) : 0
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
          //! the feeder's gate rides its digests to us (I-33): read it before anything can return
          if (v.w === 1 || v.w === 0) this.feederOpen = v.w === 1
          if (this.resync === null) {
            for (const [origin, d] of this.streams)
              if (d.applied > (typeof v.d[origin] === 'number' ? (v.d[origin]          ) : 0)) return this.#resyncBegin(link)
          }
          //! the end is the reply to a digest sent AFTER the resync began (q ≥ the resync's own; the failover's fresh
          // r=1 counts); a reply to an older digest is NOT the end — the re-download is still on its way behind it,
          // and what that older reply's ship brought stays in the fold (see `resync`). No q: an old server's reply.
          else if (v.r === 0 && (typeof v.q !== 'number' || v.q >= this.resync.q)) this.#resyncEnd()
          link.synced = true
          //! a feeder's r=1 is answered r=0 with our tails — unless we are in a resync. In resync the ask is out on THIS
          // link (the single-feeder rule above: only the primary reaches here, and every ask goes to the primary) and
          // its reply is the end. An r=1 that lands before that reply was sent before the feeder handled the ask — its
          // heartbeat floor crossing the ask at a failover — and an r=0 of ours would carry d = {} and make the feeder
          // ship its held subset a SECOND time (the review of stage 2 measured the double ship on 30 of 30 tick-aligned
          // seeds; the lane dropped the duplicates, the cost was a second download). So it gets no answer; the gate it
          // carried was read above. The one r=1 that means the ask needs re-sending is the feeder's DRAIN digest
          // (`h: 1`: its queue overflowed, or a digest arrived, while paused — an ask that arrived then was swallowed; an
          // answer whose ship stopped or whose reply a clear took the feeder resumes itself, #answer, and its reply
          // lands BEFORE this digest): that one is answered
          // with an r=1 of our own, so the exchange ships everything and its reply ends the resync, one exchange
          // after the drain (see `resync`).
          if (v.r === 1) {
            if (this.resync === null) this.#sendDigest(link, 0)
            else if (v.h === 1) this.#sendDigest(link, 1)
          }
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
        //! the answer: the suffix ship, the link sync and the r=0 reply (#answer — resumable at the drain when
        // its ship stops at a full queue or a clear takes it). A client's r=1 carries `q`; the reply echoes it (only clients send one).
        this.#answer(link, v.d, v.r, typeof v.q === 'number' ? v.q : undefined)
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
        if (f.verb === VERB.HAVEQ) this.scope .onHaveQ(this, link, f.value         )
        else if (f.verb === VERB.HAVEA) this.scope .onHaveA(this, link, f.value         )
        else if (f.verb === VERB.ACQ) this.scope .onAcq(this, link, f         )
        else this.scope .onAcqDone(this, link, f.value         )
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
        const v = f.value                           
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
        return onDiagQ(this, link, f.value                           )
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
  logFor(origin        )             {
    let l = this.logs.get(origin)
    if (!l) { l = []; this.logs.set(origin, l) }
    return l
  }

  //! ── the per-partition index (byPart, scoped only — each call is one null check unscoped) ──
  //! indexAppend — an entry that went on a lane's TAIL: its seq is above every entry of that lane, so it
  // goes on the tail of its (lane, p) array too (ascending by construction).
  indexAppend(origin        , e          ) {
    const idx = this.byPart
    if (idx === null) return
    const p = partitionOf(e.rec)
    let per = idx.get(p)
    if (per === undefined) idx.set(p, per = new Map())
    const arr = per.get(origin)
    if (arr === undefined) per.set(origin, [e])
    else arr.push(e)
  }

  //! indexInsert — an entry spliced into a lane's INTERIOR (the dual fence, a fold, a replayed interior
  // row): binary search by seq in its (lane, p) array keeps that array ascending like the lane.
  //! It is also the one place every interior insert passes, so it lowers the cover of a stopped or queued digest
  // answer (Link.torn / Link.inQueue, #answer) that already sits at or above the new entry: a cover is a map of
  // tails and cannot hold a record below it. Without this, a record spliced under a stopped answer's cover is never
  // shipped, and one tap-forwarded behind a queued reply and cleared with it is never shipped again — a spoke in
  // resync ends without that row and sweeps it (the review of the resume-cost fix, 2026-10-11). Only client links
  // carry a cover on a node that splices (an armed one: its member links get no suffix), and only while paused.
  // The check walks #covered, not every client link: one size check when no answer is stopped or queued.
  //! The cost: lowering a cover re-sends that lane's whole suffix above the splice, frames the peer may already
  // hold included, so splices that keep landing under one long torn answer keep moving its resume point back and
  // delay its reply until they stop (every row still arrives). Splices are cold (a heal, a fetch fold); a per-link
  // list of spliced entries sent ahead of the cover walk would make each cost one record (a STATUS idea).
  indexInsert(origin        , e          ) {
    if (this.#covered.size) for (const l of this.#covered) {
      if (l.torn === null && l.inQueue === null) { this.#covered.delete(l); continue }
      if (l.torn !== null && (l.torn.d[origin] ?? 0) >= e.seq) l.torn.d[origin] = e.seq - 1
      if (l.inQueue !== null && (l.inQueue.d[origin] ?? 0) >= e.seq) l.inQueue.d[origin] = e.seq - 1
    }
    const idx = this.byPart
    if (idx === null) return
    const p = partitionOf(e.rec)
    let per = idx.get(p)
    if (per === undefined) idx.set(p, per = new Map())
    const arr = per.get(origin)
    if (arr === undefined) { per.set(origin, [e]); return }
    let lo = 0, hi = arr.length
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (arr[mid].seq < e.seq) lo = mid + 1; else hi = mid }
    arr.splice(lo, 0, e)
  }

  //! indexDrop — entries that LEFT a lane (compaction, a shed's filter, a test's injected drop): removed by
  // identity from their (lane, p) arrays; an emptied array leaves the map, an emptied partition too.
  indexDrop(origin        , dropped            ) {
    const idx = this.byPart
    if (idx === null || dropped.length === 0) return
    const gone = new Set(dropped)
    const parts = new Set        ()
    for (const e of dropped) parts.add(partitionOf(e.rec))
    for (const p of parts) {
      const per = idx.get(p)
      const arr = per?.get(origin)
      if (per === undefined || arr === undefined) continue
      const kept = arr.filter((e) => !gone.has(e))
      if (kept.length) per.set(origin, kept)
      else { per.delete(origin); if (per.size === 0) idx.delete(p) }
    }
  }

  //! tombAdd / tombDrop — the tombstone index (tombs, scoped only). tombDrop parses the key: a cold path
  // (tombstone GC, the sim's injected drop); apply's sites pass the partition they already hold.
  tombAdd(p        , k        ) {
    const t = this.tombs
    if (t === null) return
    let s = t.get(p)
    if (s === undefined) t.set(p, s = new Set())
    s.add(k)
  }
  tombDrop(k        ) {
    const t = this.tombs
    if (t === null) return
    const path = JSON.parse(k)            
    const p = path.length ? path[0] : ''
    const s = t.get(p)
    if (s !== undefined && s.delete(k) && s.size === 0) t.delete(p)
  }

  //! #answer — what a peer's digest gets: the suffix ship, the link sync, and the r=0 reply to an r=1. For each
  // origin I hold, everything past the peer's high-water (`d`): encodeRuns splits Lamport gaps into valid contiguous
  // frames (attempt identity rides along, so a healed peer rebuilds its cid-dedup window too); ship() honours
  // backpressure. The peer's digest is what SYNCS the link: the suffix shipped covers everything up to this instant,
  // and every record from here on has a higher seq — per-origin monotonicity holds on the wire. r=1 means "answer
  // with yours": the reply carries r=0, so the exchange is two-legged, never a loop.
  //! M6 (armed): a MEMBER link gets NOTHING (DESIGN-SCALE stage 2, §3): on a scoped cluster a member receives history
  // only through the one-teacher latch with its attested cut — the digest only syncs the link (an admit, a drain), and
  // the round that follows it is the repair. A suffix shipped from a ring-filtered walk was the second teacher the H3
  // resurrection needs once compaction runs (stage 3 requires this). A CLIENT link is unchanged: it gets this node's
  // HELD subset (an orphan's frozen copy is a teacher for holders, never a spoke feed), with each entry's STORED pp.
  //! A TORN ship (the third re-check of stage 2, 2026-10-10; its costs fixed 2026-10-11). The shell steps `pause`
  // inside a send, so this link can pause partway through the ship, and then every further frame waits in the link's
  // bounded queue. The ship never overflows that queue on purpose: when the link is paused and the queue is full it
  // STOPS before the next frame, encodes nothing more, and keeps the rest of the answer on the link (`torn`: a cover
  // map — the peer's tails raised to what this answer has already handed the link — and the digest's r and q). The
  // link stays unsynced (live records wait: the resume walks every lane to its end, so it covers them) and no reply
  // goes out. The drain flushes the queue and calls back here with the cover as `d`: each lane's resume point is a
  // binary search, and only the frames shipped this round are encoded, so a torn ship costs what it ships — linear in
  // its size, where re-walking and re-encoding the rest of the lane every round was quadratic (160k sparse records:
  // 93 rounds and 15.8 s of feeder CPU). Every drain round delivers the queue plus what the socket takes, so a ship
  // larger than both still ends, and the reply follows the whole ship. A frame of this answer that is still queued
  // when ANYTHING clears the queue (a live tap-forward, the drain digest) moves the resume point back to the answer's
  // first queued frame (Link.inQueue, kernel/link.ts ship): an answer stays resumable until its reply has left the
  // queue, so a cleared reply costs the frames it lost, never a re-download from zero. Before the 2026-10-10 fix the
  // loop ran on past a clear, the reply went out over the hole, and a spoke lost 5 of 10 rows with a queue of 4.
  #answer(link      , d                         , r                    , q                    ) {
    const j = this.journal
    let shipped = 0
    let tear                = null // the origin the ship stopped in ('' = the lanes are done, only the reply waits)
    let tearSeq = 0 // and the first seq it did not ship
    if (!this.armed || link.client) {
      const scopedTo = this.armed ? (p        ) => this.scope .held(p) : null
      const run                                                                                                      = []
      lanes: for (const [origin, entries] of this.logs) {
        const theirs = typeof d[origin] === 'number' ? (d[origin]          ) : 0
        //! the resume point: entries are seq-ascending (a splice inserts at its seq), so the first one past the peer's
        // tail is a binary search — never a walk of the lane
        let lo = 0, hi = entries.length
        while (lo < hi) { const mid = (lo + hi) >>> 1; if (entries[mid].seq > theirs) hi = mid; else lo = mid + 1 }
        let i = lo
        while (i < entries.length) {
          if (link.paused && link.queued.length >= link.maxQueued) { tear = origin; tearSeq = entries[i].seq; break lanes }
          //! one frame's run, by the codec's own rule: the split is exactly encodeRuns' over the held subset
          // (armed AE answers carry each entry's STORED pp — the floor law: the receiver's floors advance only through
          // chain-verified spans; unscoped answers stay flag-free, bytes unchanged)
          run.length = 0
          for (; i < entries.length; i++) {
            const e = entries[i]
            if (scopedTo !== null && !scopedTo(partitionOf(e.rec))) continue
            const m = { rec: e.rec, origin, seq: e.seq, epoch: e.epoch, iss: e.iss, cid: e.cid, pp: e.pp }
            if (run.length && !continuesRun(run[0], run.length, m)) break
            run.push(m)
          }
          if (!run.length) break
          if (link.paused && link.inQueue === null) {
            link.inQueue = { d: this.#cover(d, origin, run[0].seq), r, q }
            if (link.client) this.#covered.add(link)
          }
          link.ship(encodeRuns(run, undefined, this.armed)[0], this.env.sink, j)
          shipped += run.length
        }
      }
    }
    //! the reply is one more frame: it never overflows the queue either
    if (tear === null && r === 1 && link.paused && link.queued.length >= link.maxQueued) tear = ''
    if (shipped) j.armed && j.emit(JK.aeShip, link.uuid, shipped)
    if (tear === null) {
      link.synced = true
      if (r === 1) {
        if (link.paused && link.inQueue === null) {
          link.inQueue = { d: this.#cover(d, null, 0), r, q }
          if (link.client) this.#covered.add(link)
        }
        this.#sendDigest(link, 0, q)
      }
      return
    }
    link.synced = false
    link.torn = { d: this.#cover(d, tear === '' ? null : tear, tearSeq), r, q }
    // (a stop needs a full queue, and with tune.queued ≥ 1 this call queued a frame first, so inQueue already added
    // the link; the add here keeps the rule local: wherever a cover is set, the link is in #covered)
    if (link.client) this.#covered.add(link)
  }

  //! #cover — the cold path of a stopped or queued answer: the peer's tails `d` (as numbers: the decoded frame's map is
  // not ours to hold), raised on every lane this answer walked before `origin` to that lane's tail, and on `origin`
  // to just under `seq`; `origin` null = every lane walked. An answer from it as `d` ships exactly what is left.
  #cover(d                         , origin               , seq        )                         {
    const c                         = {}
    for (const o in d) if (typeof d[o] === 'number') c[o] = d[o]          
    for (const [o, entries] of this.logs) {
      const t = o === origin ? seq - 1 : entries.length ? entries[entries.length - 1].seq : 0
      if (t > (c[o] ?? 0)) c[o] = t
      if (o === origin) break
    }
    return c
  }

  //! #sendDigest — announce {origin: highestHeldSeq} (the log tails: exactly what this node can serve).
  // Durable mode adds the p map (durable tails) — the persisted-confirm evidence; non-durable digests
  // are byte-identical with M0-M3.
  //! `q` (DESIGN-SCALE stage 2, see `resync`): a CLIENT's r=1 mints a correlation id (or carries the one its caller
  // minted); a server's r=0 toward a client echoes the asker's. Members never send one: member bytes are unchanged.
  //! A CLIENT in resync announces NO tails: what it holds mid-resync is whatever ship landed first, and a tail raised
  // by a stale ship would hide the rows under it from a feeder that holds the lane in full. "Send me everything";
  // the lane drops what it already has (write.ts #splice, dupDrop).
  //! `h` (the drain digest, see `resync`): toward a CLIENT, `h: 1` says this link dropped frames while paused — the one
  // event after which an ask of the spoke's may have no reply coming. Member digests never carry it: bytes unchanged.
  #sendDigest(link      , r       , q         , h          ) {
    const d                         = {}
    if (!(this.client && this.resync !== null))
      for (const [origin, entries] of this.logs) if (entries.length) d[origin] = entries[entries.length - 1].seq
    let body                                                                                                          
    if (this.durable) {
      const p                         = {}
      for (const [origin, s] of this.streams) if (s.durable > 0) p[origin] = s.durable
      body = { d, r, p }
    } else body = { d, r }
    //! toward a CLIENT, the digest also carries this node's write-gate (I-33): the client has no gate of
    // its own, and a closed gate here parks its relayed writes. Member-to-member digests are unchanged.
    if (link.client) body.w = this.membership.gate(this).open ? 1 : 0
    if (this.client && r === 1) body.q = q ?? ++this.#dq
    else if (q !== undefined) body.q = q
    if (h === true && link.client) body.h = 1
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
  apply(rec     , origin        , seq        , epoch        , iss         , cid         ) {
    const path = rec.key.length ? rec.key : [rec.at ?? '']
    const k = JSON.stringify(path) // unambiguous internal key — wire keys stay length-prefixed
    //! LWW: lexicographic (epoch, seq, origin), identical on every node — apply iff strictly newer than the held stamp
    const cur = this.versions.get(k)
    if (cur && !newer(epoch, seq, origin, cur)) {
      this.journal.armed && this.journal.emit(JK.lwwSkip, origin, seq)
      //! a refused record that carries an attempt identity is a write somebody is waiting on: it
      // committed at these coordinates and lost — say so downstream (env.ts lost), since no apply will
      if (iss !== undefined) this.env.sink.lost?.(iss, cid , origin, seq, epoch)
      return
    }
    //! ACROSS DEPTH (V4-18, overlapping cells): a field cell loses to ANY ancestor stamped at or above
    // it — the whole-row write (or row remove) at stamp T carried, or erased, this field, and a field
    // write older than T is the older fact. Same `newer`, every depth: ['r','a','b'] asks ['r'] then
    // ['r','a']. A duplicate never gets here (the cell's own stamp refused it above), and a row write
    // (depth 1) has no ancestor, so the whole-row path pays nothing. The ancestor keys are kept: the
    // index registers this cell under each of them below.
    const depth = path.length
    let above                  = null
    if (depth > 1) {
      above = []
      let a = '[' + JSON.stringify(path[0])
      for (let d = 1; ; d++) {
        const ak = a + ']'
        const va = this.versions.get(ak)
        if (va !== undefined && !newer(epoch, seq, origin, va)) {
          this.journal.armed && this.journal.emit(JK.subsumed, origin, seq, 0)
          if (iss !== undefined) this.env.sink.lost?.(iss, cid , origin, seq, epoch) // committed, then lost (as above)
          return
        }
        above.push(ak)
        if (d === depth - 1) break
        a += ',' + JSON.stringify(path[d])
      }
    }
    const stamp = { epoch, seq, origin }
    this.versions.set(k, stamp) // a remove leaves this as a tombstone deliberately
    const old = this.#entryHash.get(k)
    if (old !== undefined) { this.#hash = (this.#hash - old) | 0 }
    if (rec.type === REC.remove) {
      this.state.delete(k)
      this.#entryHash.delete(k)
      if (this.tombs !== null) this.tombAdd(path[0], k) // the tombstone index (scoped only)
    } else {
      this.state.set(k, rec.value)
      const h = fnv(k + '' + stable(rec.value))
      this.#entryHash.set(k, h)
      this.#hash = (this.#hash + h) | 0
      if (this.tombs !== null) { const s = this.tombs.get(path[0]); if (s !== undefined && s.delete(k) && s.size === 0) this.tombs.delete(path[0]) } // live again
    }
    //! the index: a field cell — live, or the tombstone a field remove leaves — goes under each ancestor
    if (above !== null)
      for (const ak of above) {
        let s = this.deep.get(ak)
        if (s === undefined) this.deep.set(ak, s = new Set())
        s.add(k)
      }
    //! THE SWEEP: this write won its cell, so every field cell UNDER it stamped at or below it is an
    // older fact it carried or erased — out of state, the entry hash and the rolling hash, exactly like
    // a remove; its version becomes this stamp (a tombstone, so a late copy of the swept record loses
    // for free) and it leaves the index. No remove goes downstream for a swept cell: this record's
    // apply carries the whole value. A descendant stamped ABOVE this write stays, and is re-applied
    // downstream on top of this value once it has landed — a live field set again, a field REMOVE
    // deleted again — so the projection reads the same as if it had arrived after. One lookup finds
    // exactly this write's subtree; a partition with nothing under this path pays that lookup only.
    let survivors                  = null
    const kids = this.deep.get(k)
    if (kids !== undefined) {
      for (const c of kids) { // unlink deletes c from this very set mid-walk — a Set tolerates that
        const vc = this.versions.get(c) 
        if (newer(vc.epoch, vc.seq, vc.origin, stamp)) { (survivors ??= []).push(c); continue }
        if (this.state.delete(c)) {
          this.#hash = (this.#hash - this.#entryHash.get(c) ) | 0
          this.#entryHash.delete(c)
          this.journal.armed && this.journal.emit(JK.subsumed, vc.origin, vc.seq, 1)
        }
        this.versions.set(c, stamp)
        if (this.tombs !== null) this.tombAdd(path[0], c) // swept: a stamp with no value is a tombstone
        this.unlink(c)
      }
    }
    this.env.sink.apply({ type: rec.type, key: rec.key, value: rec.value, at: rec.at, origin, seq, epoch, iss, cid })
    if (survivors !== null) this.#reapply(survivors)
    if (above !== null && rec.type === REC.remove) this.#unvivify(path, above)
  }

  //! #unvivify — after a field REMOVE lands downstream, take back what the removed field alone had made
  // up. The projection vivifies the rows a field write lands in (api/substrate.ts): ['r','f','x'] = 1
  // under a row with no `f` creates `f: {}` on the screen, and a later remove of x leaves that `{}`
  // behind — where a node that refused the write (or a late joiner) shows nothing. The cells say what
  // is right: the nearest LIVE ancestor's own value at that level, or nothing at all. So, walking up
  // from the removed cell's parent to just below the nearest live ancestor: a level with a live field
  // still under it stays (the fields keep it, on every node); a level a newer field remove took out
  // (its own indexed tombstone), or anything under such a level, goes; a level the live ancestor's
  // value holds as an object stays (it was never made up); any other level was made up by the field —
  // it goes back to the value's own thing there (a scalar the field was written over) or away. The
  // live ancestor itself is the last level: its own value is not a plain object (5, null, 'txt' — a
  // value a field cannot land in, so the projection made `{}` up OVER it — or an array) and nothing
  // live is left under it — the value comes back as itself. The repairs ride this node's own name at
  // seq 0, like a resync's ghost removes: never logged, never on the wire, and the api collects no
  // settlement from them.
  //! The guarantee (the same screen in every arrival order) is for OBJECT rows, and for numbers, null
  // and strings as the tests cover them; a string row under a NUMERIC field key is outside it (data
  // spreads the string's characters into the object it makes up, and a remove there can depend on
  // order). ARRAYS are the limit: data writes into an array like into an object — an index write
  // replaces the element, a field inside an element lands (making up any level missing inside it),
  // and a non-index key becomes a hidden array property — but it refuses to remove an array's own key
  // (a sparse hole), which the substrate folds as a no-op for a replicated record. So an array row's
  // screen can still differ by arrival order (an index write under a newer index remove, a level made
  // up inside an element next to a live sibling). This walk makes no per-level repair under an array.
  #unvivify(path          , above          ) {
    let live = -1
    for (let j = above.length - 1; j >= 0; j--) if (this.state.has(above[j])) { live = j; break }
    let cut = above.length // the shallowest level under `live` that a newer remove took out
    for (let j = live + 1; j < above.length; j++)
      if (j > 0 && this.versions.has(above[j]) && this.deep.get(above[j - 1])?.has(above[j])) { cut = j; break }
    for (let j = above.length - 1; j > live; j--) {
      const kids = this.deep.get(above[j])
      if (kids !== undefined) for (const c of kids) if (this.state.has(c)) return
      let v          = undefined, has = false, ignored = false
      if (live >= 0 && j < cut) {
        v = this.state.get(above[live]); has = true
        for (let i = live + 1; i <= j && has; i++) {
          if (isPlain(v) && Object.hasOwn(v, path[i])) v = v[path[i]]
          else { has = false; ignored = typeof v === 'object' && v !== null && !isPlain(v) }
        }
        //! the value holds this level itself (an object, or an array): never made up — it and every
        // level above it stay
        if (has && typeof v === 'object' && v !== null) return
      }
      //! an ARRAY (or a typed array) sits above this level in the value: no per-level repair here. Data
      // does write under an array (see the banner: elements, fields inside them, hidden properties), but
      // a repair that removes an array's own key would be refused (data will not leave a sparse hole),
      // and the array's own value is re-emitted whole below when nothing live is left under it. What
      // a field made up inside an element next to a live sibling stays — the array limit.
      if (ignored) continue
      const key = path.slice(0, j + 1)
      if (has) this.env.sink.apply({ type: REC.update, key, value: v, origin: this.uuid, seq: 0, epoch: 0 })
      else this.env.sink.apply({ type: REC.remove, key, origin: this.uuid, seq: 0, epoch: 0 })
    }
    if (live < 0) return
    const own = this.state.get(above[live])
    if (isPlain(own)) return
    const kids = this.deep.get(above[live])
    if (kids !== undefined) for (const c of kids) if (this.state.has(c)) return
    this.env.sink.apply({ type: REC.update, key: path.slice(0, live + 1), value: own, origin: this.uuid, seq: 0, epoch: 0 })
    //! an ARRAY comes back whole — and data writes into an array (a field inside an element lands), so the
    // array's own value still holds what a NEWER remove under it took out (`delete todos[0].done`: the
    // re-emit alone put `done` back on the screen). Every cell under it is a tombstone here (a live one
    // returned above), each newer than the array: take them out again, shallowest first, as repairs.
    // Not the ones directly under the array: data refuses to delete an array's own key (a sparse hole),
    // and the whole value just replaced whatever a field had put there.
    if (Array.isArray(own) && kids !== undefined) {
      const under             = []
      for (const c of kids) { const p = JSON.parse(c)            ; if (p.length > live + 2) under.push(p) }
      under.sort((a, b) => a.length - b.length)
      for (const key of under) this.env.sink.apply({ type: REC.remove, key, origin: this.uuid, seq: 0, epoch: 0 })
    }
  }

  //! #reapply — put field cells back on top downstream, shallowest first, after a write ABOVE them (an
  // older row write arriving late, a ghost row removed at a resync) replaced or erased the object they
  // live in. A live cell goes out as its own record again (the log entry, so a keyed insert re-inserts;
  // an update of the held value when the entry is gone); a tombstone goes out as a remove, so the field
  // the newer remove took is taken out of the late row's value too. Each rides its own stamp, with no
  // attempt identity — this is a projection repair, not a commit, and the api's join must not mistake
  // it for one.
  #reapply(cells          ) {
    const paths = cells.map((c) => JSON.parse(c)            )
    const order = paths.map((_, i) => i).sort((i, j) => paths[i].length - paths[j].length || (cells[i] < cells[j] ? -1 : 1))
    for (const i of order) {
      const c = cells[i]
      const v = this.versions.get(c) 
      if (!this.state.has(c)) {
        this.env.sink.apply({ type: REC.remove, key: paths[i], origin: v.origin, seq: v.seq, epoch: v.epoch })
        this.#unvivify(paths[i], ancestorsOf(paths[i]))
        continue
      }
      const e = this.#entryAt(v.origin, v.seq)
      if (e !== null) this.env.sink.apply({ type: e.rec.type, key: e.rec.key, value: e.rec.value, at: e.rec.at, origin: v.origin, seq: v.seq, epoch: v.epoch })
      else this.env.sink.apply({ type: REC.update, key: paths[i], value: this.state.get(c), origin: v.origin, seq: v.seq, epoch: v.epoch })
    }
  }

  //! unlink — take a cell out of the deep index (every ancestor's set; an emptied set leaves the map).
  // Called where a field cell stops being an independent fact: swept by a parent write, dropped by a
  // shed, or released by tombstone GC. A cold path when the cell is not indexed: a depth-1 key is
  // never indexed, and with no field cells at all nothing is parsed.
  unlink(k        ) {
    if (this.deep.size === 0) return
    const path = JSON.parse(k)            
    for (let d = 1; d < path.length; d++) {
      const ak = JSON.stringify(path.slice(0, d))
      const s = this.deep.get(ak)
      if (s !== undefined && s.delete(k) && s.size === 0) this.deep.delete(ak)
    }
  }

  //! fenced — is this tombstone one a LIVE ancestor still needs? A field remove stamped above its row
  // took one field out of a row that is still there: the remove must stay the winner of its cell, so
  // compaction keeps its entry and a late joiner folds the same row (kernel/log.ts gcTombstones asks).
  // A tombstone a parent write swept is no longer indexed and goes with the rest.
  fenced(k        )          {
    if (this.deep.size === 0) return false
    const path = JSON.parse(k)            
    if (path.length < 2 || !this.deep.get(JSON.stringify([path[0]]))?.has(k)) return false
    for (let d = 1; d < path.length; d++) if (this.state.has(JSON.stringify(path.slice(0, d)))) return true
    return false
  }

  //! fields — every indexed cell of partition p (live fields and fenced tombstones), as a copy.
  fields(p        )           { return [...(this.deep.get(JSON.stringify([p])) ?? [])] }

  //! #entryAt — the log entry stamped (origin, seq), by binary search (lanes are seq-ascending); null
  // when the lane is gone (shed, condemned) or the entry is not there.
  #entryAt(origin        , seq        )                      {
    const lane = this.logs.get(origin)
    if (lane === undefined) return null
    let lo = 0, hi = lane.length - 1
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1
      const s = lane[mid].seq
      if (s === seq) return lane[mid]
      if (s < seq) lo = mid + 1; else hi = mid - 1
    }
    return null
  }

  //! #under — the LIVE field cells strictly below the cell `k` (its descendants), from the deep index.
  #under(k        )           {
    const kids = this.deep.get(k)
    if (kids === undefined) return []
    const out           = []
    for (const c of kids) if (this.state.has(c)) out.push(c)
    return out
  }

  //! stateHash — order-insensitive rolling hash over entries: O(1) per apply, comparable per event (the sim's convergence + replay-determinism checks key off it).
  get stateHash()         { return this.#hash | 0 }

  //! dropCell — remove one state cell OUTSIDE the LWW election (M6 shed: the data lawfully leaves
  // this node without a remove record existing anywhere). Maintains the rolling hash exactly like
  // apply()'s remove arm — a shed that bypassed this would silently poison every convergence check.
  dropCell(k        ) {
    const old = this.#entryHash.get(k)
    if (old !== undefined) { this.#hash = (this.#hash - old) | 0; this.#entryHash.delete(k) }
    this.state.delete(k)
    this.unlink(k) // the deep index follows (V4-18): a dropped field, live or tombstone, is no fact here any more
  }

  //! admitted — identified peer uuids (harness predicate: cluster formed ⇔ everyone admits everyone).
  // Dead links are EXCLUDED even before their linkDown echo: a dup-race loser is marked dead
  // synchronously, and counting it double-counted its uuid in genesis membership (review finding —
  // a committed view with a duplicated member permanently poisons majority arithmetic).
  admitted()           {
    const out           = []
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

//! newer — THE conflict-resolution order (plan §5): is the stamp (epoch, seq, origin) strictly newer than
// `cur`? Lexicographic, epoch first. One predicate for the per-cell election and the across-depth rule
// (apply), so the two can never drift; tools/debug/model.mjs mirrors it by name.
export const newer = (epoch        , seq        , origin        , cur                                                )          =>
  epoch > cur.epoch || (epoch === cur.epoch && (seq > cur.seq || (seq === cur.seq && origin > cur.origin)))

//! isPlain — a plain object: a value the kernel's repairs walk INTO. Arrays and bytes are not — data does
// write into an array (see #unvivify's banner), but the kernel treats one as a whole value: the array limit.
const isPlain = (v         )                               => typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Uint8Array)

//! ancestorsOf — the keys of a path's proper prefixes, shallowest first (the cold-path twin of apply's loop).
const ancestorsOf = (path          )           => {
  const out           = []
  for (let d = 1; d < path.length; d++) out.push(JSON.stringify(path.slice(0, d)))
  return out
}

//! fnv — fnv-1a over a string; the per-entry hash the rolling state hash sums.
const fnv = (s        )         => {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) }
  return h | 0
}
//! stable — deterministic stringify (sorted object keys, NaN- and bytes-aware) for hashing and state
// comparison only; never on the wire path. Exported so sim monitors diff values with the SAME notion of
// equality the hash uses (JSON.stringify can't tell NaN from null — a diff that lies is worse than none).
export const stable = (v         )         => {
  if (v === undefined) return 'u'
  if (v === null || typeof v !== 'object') return typeof v + ':' + String(v)
  if (v instanceof Uint8Array) return 'b:' + Array.from(v).join(',')
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']'
  return '{' + Object.keys(v).sort().map((k) => k + '=' + stable((v                           )[k])).join(',') + '}'
}
