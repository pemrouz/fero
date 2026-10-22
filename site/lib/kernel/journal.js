//! ── kernel/journal — the ONE canonical diagnostics event stream ──────────────
// v2 grew five uncoordinated diagnostic channels (inspect / observe / writes
// ring / births sink / WAL) because observability was retrofitted per milestone.
// v3 inverts it (plan §8): the journal vocabulary exists BEFORE the layers that
// emit into it, every layer emits here, and every other diagnostic surface is a
// view over this ring. Three v2 lessons are baked into the shape:
//
//   - Events are FLAT SCALARS only (numbers/strings), never value payloads —
//     v2's ProvRecord got this right; it is what keeps emit sites allocation-light.
//   - The ring is a purpose-built bounded drop-oldest array with a cursor API,
//     NOT a ViewProxy — v2 faked its event stream as a proxy ring (slot identity
//     = t % cap) and every consumer paid a reorder-by-t burden plus a measured
//     ~3x proxy-trap tax per watched write.
//   - Overflow is NEVER silent: the drop counter is surfaced on the journal
//     itself (a lie of omission was v2's EVENT_CAP behaviour).
//
// Emit sites in the kernel are single predicted-false branches when unwatched
// (`j.armed && j.emit(...)`) — v2's measured zero-cost-when-off contract, kept.
// In sim runs the journal is always armed: it doubles as the replay/trace spine.

//! JK: the closed journal-event vocabulary. Append-only over time (viewer filters key off it); kinds are never renumbered.
export const JK = {
  dial: 1,        // a=to
  linkUp: 2,      // a=link, b=dialed(0|1)
  identified: 3,  // a=link, b=uuid, c=incarnation
  dupLink: 4,     // a=closedLink, b=keptLink — one-logical-link-per-pair dedup fired
  selfReject: 5,  // a=link — a handshake presented our OWN uuid
  linkDown: 6,    // a=link, b=reason
  frameDrop: 7,   // a=link, b=reason — wire fault (FrameError): the link is dropped
  writeLocal: 8,  // a=seq, b=partition
  applyInbound: 9,// a=origin, b=seq
  holdBack: 10,   // (reserved — the M0 hold-back was deleted when Lamport seqs made contiguity wrong; kinds are append-only, never renumbered)
  dropOldest: 11, // a=link, b=droppedCount — bounded outbox overflow (journal-visible loss, plan §3.4)
  pause: 12,      // a=link — send-plane backpressure engaged
  drain: 13,      // a=link
  ping: 14,       // a=link
  redial: 15,     // a=delayMs, b=to
  dupDrop: 16,    // a=origin, b=seq — duplicate delivery discarded by the high-water
  start: 17,
  giveUp: 18,     // a=to — redial attempts exhausted for a target; journal-visible, never a silent stall
  lwwSkip: 19,    // a=origin, b=seq — a record lost its per-cell LWW election (applied watermark still advances)
  catchup: 20,    // (reserved — the blind whole-log replay-on-admit was superseded by digest-gated anti-entropy; append-only vocabulary)
  digestOut: 21,  // a=link, b=r — sent our per-origin high-water digest (r=1 asks the peer to answer with theirs)
  digestIn: 22,   // a=link — received a peer digest
  aeShip: 23,     // a=peerUuid, b=records — anti-entropy shipped the suffixes the peer's digest showed missing
  revive: 24,     // a=to — the heartbeat floor revived a given-up dial target (give-up is a cool-down, not death)
  //! ── M2 membership vocabulary (views, ballots, the write-gate) ──
  suspect: 25,       // a=uuid — a committed-view member unreachable SUSPECT_TICKS consecutive ticks
  propose: 26,       // a=epoch, b=memberCount — this node proposed a view ballot
  vote: 27,          // a=epoch, b=granted(0|1), c=proposer — this node answered a ballot
  viewInstall: 28,   // a=epoch, b=memberCount — a view became committed fact here
  epochStale: 29,    // a=observedEpoch — evidence of a higher committed view; the write-gate closes
  gateClose: 30,     // a=reason ('stale-epoch'|'rejoining'|'evicted'|'joining'|'held'|'minority') — joining: not in the view and never was (a newcomer before its JOIN ballot); held: this node voted for a view two or more members apart from its own, which may exist (DESIGN-LEAVE §10.10), so it is read-only until that view commits, its proposer disowns it, or its own majority supersedes it
  gateOpen: 31,
  gateAlarm: 32,     // a=wantedEpoch — pull retries exhausted; gate RELEASED with this alarm (named, never silent)
  writeBuffered: 33, // a=queueDepth — a gated write parked in the bounded pending buffer
  writeBufferDrop: 34, // a=totalDropped — pending overflow dropped the oldest batch (surfaced loss)
  join: 35,          // a=uuid — a JOIN request sent (a=self) or received (a=joiner)
  evict: 36,         // a=uuid — this member left the committed view at install (voted out — or it asked to leave: see leave/left)
  //! ── M3 write-pipeline vocabulary (owner routing, cid dedup, NACKs) ──
  writeForward: 37,  // a=ownerUuid, b=baseCid, c=count — an attempt run forwarded to the partition owner
  writeAck: 38,      // a=issuer, b=baseCid, c=count — commit coordinates received; pending attempts cleared
  writeNack: 39,     // a=reason ('not-owner'|'stale-epoch'|'withheld' — the issuer re-resolves + re-forwards; 'invalid' — the relay's validator refused it, TERMINAL), b=ownerEpoch, c=baseCid
  writeDup: 40,      // a=issuer, b=cid — owner-side cid dedup absorbed a retransmit (the duplicate ACK re-carries the ORIGINAL coordinates)
  writeRelay: 41,    // a=issuer, b=baseCid — a client attempt (attemptEpoch 0) re-stamped at this relay (the issuer/flush boundary rule)
  dedupEvict: 42,    // a=issuer — a whole cid-dedup lane evicted (MAX_ISSUERS bound); its issuer re-enters the window on next commit
  //! ── M4 durability vocabulary (WAL batches, boot record, replay) ──
  persist: 43,       // a=batch, b=bytes — a WAL batch left for the store
  persisted: 44,     // a=batch — the store resolved the batch; durable watermarks advanced
  persistFail: 45,   // a=batch, b=reason — the store FAILED the batch (surfaced; durable does not advance; confirm:'persisted' unreachable past here)
  replayed: 46,      // a=records, b=origin — one WAL frame re-ingested at boot (source=replay)
  bootWrite: 47,     // a=epoch, b=votedForEpoch — the durable boot record was (re)written
  walHole: 48,       // a=origin, b=prev — a replayed row's chain link did not match: an interior hole (lying disk); the row is skipped, the loss becomes TAIL loss for AE to heal
  //! ── M4c confirm vocabulary (the guarantee ladder) ──
  confirmReq: 49,    // a=id, b=level (CONFIRM.*), c=origin — a probe opened
  confirmed: 50,     // a=id, b=ok(0|1), c=memberCount — a probe answered (false = cancel/overflow, an honest reject)
  //! ── M4d compaction vocabulary ──
  compacted: 51,     // a=origin, b=droppedEntries — a prefix ≤ the frontier collapsed to its snapshot records; on an ARMED node (DESIGN-SCALE stage 3) c=how many partitions the pass dropped from (a count, never a name: a lane holds thousands, and one row each would flood this ring); unscoped rows carry no c
  tombstoneGC: 52,   // a=droppedStamps — remove-versions nothing can contest anymore were released
  //! ── M4e WAL snapshot vocabulary ──
  snapshot: 53,      // a=batch, b=rows — a whole-WAL snapshot+swap left for the store (the disk counterpart of compaction)
  walTaint: 54,      // a=origin — an interior hole PROVED the disk lied (fsyncgate): the restore is condemned, the fold resets to empty, the WAL swaps clean, the cluster re-teaches
  //! ── M5c method-plane vocabulary (the kernel routes; the api host runs) ──
  rpcIn: 55,         // a=verb (CALL|SUB|UNSUB), b=id, c=method — an rpc frame arrived; handed to the host via sink.invoke
  rpcAnswer: 56,     // a=id, b=ok(0|1) — a RESULT frame answered one of our rpc ids
  rpcOut: 57,        // a=verb, b=id — an rpc event shipped on the primary
  rpcFail: 58,       // a=id, b=reason — the kernel failed an rpc locally (no primary / primary died with it in flight)
  //! ── M6 scoped-replication vocabulary (DESIGN-M6 §3) ──
  shed: 59,          // a=partition, b=droppedEntries — every current holder attested; the data left this node
  acquire: 60,       // a=partition, b=entriesFolded, c=teacherUuid — the atomic one-teacher fold committed
  orphaned: 61,      // a=partition, b=epoch — held data left the R-set at install; the freeze begins
  acquireStart: 62,  // a=partition, b=teacherUuid — a one-teacher latch opened
  acquireAbort: 63,  // a=partition, b=reason ('linkDown'|'epoch'|'overflow'|'reborn'|'torn'|'timeout')
  teachShip: 64,     // a=partition, b=entries — teacher-side ACQ transfer
  gateDrop: 65,      // a=origin, b=seq — a non-held record dropped at the inbound gate (epoch-skew window; expected-rare)
  stageDrop: 66,     // a=partition, b=seq — a non-teacher transfer dropped during an open latch (expected-rare; monitored)
  shedStall: 67,     // a=partition, b=ticks — the H7 alarm at escalating cadence, never silent
  //! ── M7 DIAG vocabulary (DESIGN-M7 §1 — session audit lives HERE; the wire deny is one constant) ──
  diagAuth: 68,      // a=link, b=allowName — a diag session latched (the audit identity is the allowlist NAME; tokens never ride the journal)
  diagDeny: 69,      // a=link, b=reason ('no-config'|'bad-token'|'malformed') — journal holds the typed truth; the wire says only 'denied'
  diagPull: 70,      // a=link, b=op ('node'|'logs'|'state'), c=rows — emitted AFTER the reply builds (a pull never contains its own row).
                     // DELIBERATE asymmetry: q:'journal'/'meta' pulls are NOT journaled — journaling reads-of-the-journal at follow
                     // cadence would evict the very history being followed (a 1 Hz dash eats a 4096-cap ring in minutes). Audit anchor
                     // for a session = diagAuth + linkDown. Do not "fix" this into spam.
  //! ── v4.1 admission vocabulary ──
  nameReject: 71,    // a=link, b=theirName — the HELLO declared a DIFFERENT resource name: refused (dead + noRedial), never admitted (admitting would silently cross-replicate two resources' logs)
  //! ── spokes are views (2026-09-06, DECISIONS V4-5) ──
  resync: 72,        // a=cells — a SPOKE found itself AHEAD of its feeder (the cluster's truth moved under it): fold reset, empty r=1 digest out, re-download begins
  resynced: 73,      // a=ghosts, c=kept (wave 6c) — the re-download completed (the feeder's r=0 reply, FIFO after its suffix): cells held before that did not come back were removed downstream (a), except the c cells of partitions the reply named in flight at the feeder (`f`: an open latch, a re-entry in waiting), which stay on the screen until the fold's end judges them (FEED {e}, the `fed` row)
  //! ── the graceful leave (2026-09-07, DECISIONS V4-6) ──
  leave: 74,         // a=uuid — a LEAVE sent (a=self: this node is stopping on purpose) or received (a=the leaver): "propose the view without me"
  left: 75,          // a=epoch, b=clean(0|1), c=why — the leaver's exit: 1 = the view without it committed and a survivor echoed it (and, scoped, every partition it held was proved held elsewhere); 0 = the bound (LEAVE_TICKS, or the knock window LEAVE_WINDOW with a member linked) ran out: c='unanswered' (the vote never came back; it is still in its own view, or holds no view yet at epoch 0, and goes like a crash — suspicion + eviction follow — after counting what goes with it, `undrained`) or c='unechoed' (it committed the view without itself and no survivor echoed it) — or, with no c, after an `undrained` row: the view change committed and echoed but some of its partitions went with it
  //! ── overlapping cells (2026-10-08, DECISIONS V4-18) ──
  subsumed: 76,      // a=origin, b=seq, c=swept(0|1) — a field cell lost to a whole-row write (or row remove) stamped at or above it: refused on arrival (c=0) or swept out of state by the row write arriving later (c=1)
  //! ── the door (2026-10-09, docs/DESIGN-DOOR.md §3-§4) ──
  contractReject: 77, // a=link, b=the first contract key that differs (or missing:<key>), c=THEIR value as a string, never ours — two servers' HELLOs carried different cluster contracts (heartbeat.ms, replicas, methods, validation, ring): refused at the door, parked, re-dialed at heartbeat cadence
  doorReject: 78,    // a=link (the one that closes), b=reason, c=the dial target or the claimed listen (for 'uuid-taken' on the refusing side the uuid; on the refused client the dial target) — the door refused a link. Reasons: 'no-secret' (I have a door, the peer sent no k) · 'peer-secret' (the peer has one, I do not) · 'bad-proof' (its DOOR did not verify) · 'uuid-taken' (a CLIENT may not take a member's uuid; a member evicts a client squatting on its uuid; the refused client that read the {e: 'uuid-taken'} notice writes it too) · 'address' (a discovered or view-learned target answered as another listen: a relay) · 'timeout' (no DOOR within tune.proveMs) · 'refused' (a DOOR {e} notice — 'denied', or a word this version does not know — read while proving, after I proved; ONLY then. A bare close while proving is a link loss, not a refusal: no row, no park, the ordinary bounded redial chain — a crash, a cut or a lost notice look exactly like it, and the door speaks only through DOOR {e} (the third review)). Never a secret, nonce or proof.
  //! ── drain-then-go (2026-10-10, DESIGN-SCALE §7 stage 1 (b)) ──
  undrained: 79,     // a=partitions, b=epoch — a scoped leaver went with partitions no reachable new holder had proved it holds (the drain hit tune.drainTicks, or nobody was there to drain to: the last member, every new holder unreachable); the `left` row that follows carries b=0
  //! ── the release rule (2026-10-12, DESIGN-LEAVE §10.10) ──
  release: 80,       // a=epoch, b=proposer — the vote's proposer disowned the ballot this node held a vote for (a NACK to its ask): the vote stays spent, it warns no more, and the gate re-reads (`held` ends when it was the last hold)
  //! ── a client moves off a shut feeder (2026-10-12, wave 6b) ──
  refeed: 81,        // a=link (the feeder's), b=link (the open server's) — a CLIENT closed its feeder link on purpose: the feeder said its write-gate is shut (`w: 0`) while another linked server said its is open; the linkDown that follows elects that server, and the shut feeder is redialed as a non-primary
  //! ── the spoke edge cases (2026-10-21, wave 6c, DECISIONS V4-62; 82 and 83 are stage 4's gcRow and zombie) ──
  unfed: 84,         // a=partition, b=laneEntriesDropped — a CLIENT's feeder said the partition LEFT it (FEED {x}: a shed — its copy froze into an orphan at an install and left once every holder attested it — or a latch for it that aborted clean, holding nothing): the spoke dropped the partition's cells, lane entries, screen rows and kept cells with it (they stayed on the screen, frozen, until a failover's resync before)
  fed: 85,           // a=partition, b=framesLanded, c=ghostsJudged — a CLIENT's fold group for the partition landed: the b frames the spoke buffered (between the feeder's FEED {b} and {e}, its latch fold's forward) landed as one apply. With c (the end came, FEED {e}): every cell a resync end kept back for this partition (the reply's `f`) was judged — c of them were ghosts (the fold did not bring them) and left the screen, the rest are back in the kernel. Without c: the group was closed by a later frame (its end was lost to a clear) and nothing was judged; the feeder says the end again after the heal, and that row has b=0
}         

//! JEvent: one journal row. `t` is a per-node monotone counter (NOT wall time — deterministic under sim).
                                                                                                                  

//! KEPT_MAX — how many rows keep() holds beside the ring for a reader that has not taken them (oldest out past it)
export const KEPT_MAX = 64

//! Journal: bounded drop-oldest ring + monotone counter + surfaced drop count.
export class Journal {
  #ring                        
  #cap        
  n = 0            // total events ever emitted — ring holds the last min(n, cap)
  dropped = 0      // events lost to overflow — surfaced, never silent
  armed = true
  constructor(cap         = 4096) { this.#cap = cap; this.#ring = new Array(cap) }
  emit(kind        , a                  , b                  , c                  ) {
    const t = this.n++
    if (t >= this.#cap) this.dropped++
    this.#ring[t % this.#cap] = { t, kind, a, b, c }
  }
  //! kept / keep — the rows a reader must not lose to the ring (DECISIONS V4-66): the door's and the contract's
  // refusals (doorReject, contractReject), written through keep() at their few cold sites in kernel/node.ts. The ring
  // can overwrite a row inside the very step that wrote it, when journal.cap is below that step's burst (a member that
  // evicts a client squatting on a member's uuid goes on to admit the member in the same step); this list holds the
  // same row objects until the composer takes them after the step (api/index.ts fold) and empties it. The ring and
  // its rows are unchanged: keep() is emit() and one push of the row emit() made. Capped at KEPT_MAX, oldest out, so
  // a node nobody reads (the sim, a bare kernel) holds no more than that. No other emit site touches it: nothing on
  // the hot path pays for it.
  kept           = []
  keep(kind        , a                  , b                  , c                  ) {
    this.emit(kind, a, b, c)
    if (this.kept.length >= KEPT_MAX) this.kept.shift()
    this.kept.push(this.#ring[(this.n - 1) % this.#cap] )
  }
  //! read(from): all retained events with t >= from, in order — cursor-style consumption (relay/fold read by cursor, never by draining a shared array: v2's 10%-temporal-coverage bug class).
  read(from = 0)           {
    const lo = Math.max(from, this.n - this.#cap)
    const out           = []
    for (let t = lo; t < this.n; t++) out.push(this.#ring[t % this.#cap] )
    return out
  }
}
