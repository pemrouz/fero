//! ── kernel/write — THE single write ingress: every record enters the system here ──
// M3 (plan §5 write contract). Four sources, one door:
//
//   local     — a 'write' event from the embedder: minted an Attempt {cid,
//               attemptEpoch, issuer} at issue time, then committed here (if we
//               own the partition) or FORWARDED to the owner (never committed
//               under our own origin — v2's never-drop fallback, AA source #1,
//               is deleted, not guarded).
//   forwarded — a WRITE frame from a peer claiming we own the partition: cid-
//               deduped, then VALIDATED (owner at MY committed epoch + attempt-
//               Epoch === MY epoch + write-gate open) before the one stamp site
//               runs — v2's validate-nothing commitForwarded (AA #2) inverted.
//   inbound   — a replicated RECORDS frame: already stamped by its owner; the
//               high-water dedup + LWW election run (moved verbatim from M1),
//               and any ATTEMPT IDENTITY riding the run feeds the local
//               cid-dedup window (see below).
//   replay    — the M4 WAL boot source (lands with storage; the seam is named
//               here so the module's contract is complete on day one).
//
// The write contract, mechanically:
//   - cid = (issuer, monotone counter). The issuer string embeds the node's
//     incarnation (uuid~inc) so a restart cannot alias its predecessor's cid
//     lane before M4 makes the counter durable.
//   - attemptEpoch (ae) is stamped from the issuer's committed epoch at issue
//     time and RE-STAMPED ONLY at the issuer/flush boundary (#drain — the one
//     place a parked attempt re-enters the world; the law that makes v2's AA #3
//     "flush re-stamps at commit" unrepresentable). While parked, an attempt
//     keeps its original ae; the owner re-validates whatever ae arrives.
//   - The owner commits iff it owns the partition at its CURRENT committed
//     epoch AND ae === its epoch AND its gate is open; otherwise a typed WNACK
//     {reason: not-owner | stale-epoch | withheld, ce: ownerEpoch} and the
//     ISSUER re-resolves + re-forwards with refreshed ae. Retries are PACED:
//     a lost ACK re-parks on the tick clock (RETRY_TICKS), and a same-epoch
//     NACK re-parks onto that same clock — the adversarial review demonstrated
//     that an instant NACK→settle→re-forward loop spins at line rate against a
//     minority owner. Only a NACK/install revealing a NEWER view re-drives
//     immediately (there is fresh routing state to act on).
//   - ACK/NACK frames are accepted only from the OWNER OF RECORD (`to`, bound
//     at forward time): a well-formed control frame from any other admitted
//     link cannot clear or re-drive someone else's route (review finding).
//   - Client relay rule: an attempt arriving with ae === 0 (the client marker)
//     is RE-STAMPED at this first server (relay time IS an issuer boundary) and
//     this relay owns re-resolution on NACK; the reply routes back on the link
//     the attempt arrived on (`via`).
//
// EXACTLY-ONCE AND OWNERSHIP MOVES (the review's critical): a committed
// forwarded run BROADCASTS its attempt identity (FLAG_ATTEMPT: issuer +
// contiguous cids) and the identity is retained in the log, re-shipped by
// anti-entropy, and folded into EVERY node's dedup window on ingest. So when
// ownership moves between epochs, the new owner already knows the cids the old
// owner committed — a retry after a lost ACK dup-ACKs with the ORIGINAL
// coordinates instead of re-committing (the pre-fix behaviour resurrected a
// stale value OVER a newer acknowledged write via a fresh higher stamp).
// Replication doubles as an ACK: an ingested record carrying our own issuer
// clears the matching pending attempt (and hops coordinates to a relayed
// client), so a lost WACK heals by the data path itself. Residual, stated: a
// retry can still outrace the ORIGINAL commit's replication to the new owner —
// then the window misses and the write re-commits as a same-value higher-stamp
// supersede. M4's confirm ladder closes it (a confirmed write implies the new
// owner has the stream). The attempt-exactly-once sim monitor watches the whole
// class per event.
//
// ONE bounded queue (plan §3.4): every not-yet-committed attempt this node
// issued or relays lives in `pending` (insertion order = issue order; bounded
// drop-oldest with a surfaced counter). It replaces M2's membership buffer —
// gate-closed, owner-unreachable, NACKed, and awaiting-ACK attempts are all the
// same thing: parked work the next flush boundary re-drives. Nothing is parked
// at the OWNER: a non-committable forwarded attempt is NACKed back, so all
// buffering is issuer-side and the owner stays stateless but for the dedup
// window. A `#queued` count of parked (sent < 0) attempts lets the drain
// no-op when everything is in flight (review: every settle walked the full map).
//
// Owner-side dedup is an EXACT bounded window, not the plan's high-water +
// out-of-order set: per-owner cid streams have legitimate permanent gaps (an
// issuer's cids interleave across partitions owned by different nodes, and
// ownership moves between epochs), so "≤ high-water ⇒ duplicate" would FALSELY
// eat a first delivery — a lost write. The window keeps the last DEDUP_KEEP
// committed cids per issuer with their ORIGINAL commit coordinates (duplicate
// ACKs re-carry them: exactly-once at the commit site). Lanes themselves are
// bounded (MAX_ISSUERS, oldest-evicted, journal-surfaced) — every client that
// ever wrote must not hold kernel memory forever. A retransmit older than the
// window re-commits — a same-value, higher-stamp LWW supersede, harmless for
// idempotent records; the non-idempotent story (methods) lands with M5 and will
// size the window against the retry horizon.
//
// Epoch 0 is the OPEN mode, byte-for-byte M0/M1: no ring, no attempts, no new
// frames — a write event with an open gate goes straight to node.commit(). All
// M3 machinery activates only once a view commits (which requires heartbeats,
// which is also what clocks the retries — no view, no forwarding, no liveness debt).

import { VERB, encodeControl, encodeRuns,            } from './codec.js'
import { SCOPE } from './scope.js'
import { Ring } from './ring.js'
import { JK } from './journal.js'
import { LS,           } from './link.js'
import { partitionOf,          } from './env.js'
                                                    
                                     

//! The four bounds below are the DEFAULTS of their tune-table rows (kernel/tune.ts); the read sites
// consult `node.tune.<row>`. MAX_RUN is NOT a row: it is a wire bound, fixed on purpose.
//! MAX_PENDING: the ONE attempt-queue bound (drop-oldest, surfaced) — M2's buffer bound, moved here with the queue. Row: pending.
export const MAX_PENDING = 1024
//! RETRY_TICKS: heartbeat ticks a forwarded attempt waits for its ACK/NACK before re-resolving + re-forwarding. Row: retryTicks.
export const RETRY_TICKS = 2
//! DEDUP_KEEP: committed cids retained per issuer for the exact-window duplicate test + duplicate-ACK coordinates. Row: dedupKeep.
export const DEDUP_KEEP = 1024
//! MAX_ISSUERS: dedup lanes retained (oldest-evicted, surfaced) — lanes must not grow with every client that ever wrote. Row: issuers.
export const MAX_ISSUERS = 1024
//! MAX_RUN: the longest WACK/WNACK run (`n`) accepted off the wire — a peer claiming more cids in one
// frame than any queue could hold is garbage and the frame is dropped. It used to share MAX_PENDING's
// value; it is split off so that tuning a node's queue can never change what its wire accepts.
export const MAX_RUN = 1024

//! NACK: the typed rejection vocabulary (plan §5, verbatim) — plus `invalid` (2026-09-05): the relay's
// admission predicate refused the record. Unlike the three routing reasons it is TERMINAL — no retry can
// change the answer — and the validator's reason text rides beside it as `m`.
export const NACK = { notOwner: 'not-owner', staleEpoch: 'stale-epoch', withheld: 'withheld', invalid: 'invalid' }         
//! REASON_MAX: the validator's reason is user-authored text riding a control frame — bounded on the way out.
export const REASON_MAX = 256

//! Attempt: one record's write-route state, from issue to commit/ACK. `via` is the link to answer on
// for relayed client attempts (-1 = locally issued); `sent` is -1 while parked, else ticks since
// forwarded; `to` is the owner of record — the uuid this attempt was last forwarded to (ACK/NACK
// frames from anyone else are ignored).
                   
             
            
                
          
             
              
            
                                                                                            
 

export class Writes {
  ring = new Ring()
  //! the ONE bounded queue — key `issuer|cid`, insertion order preserved (issue order per issuer)
  pending = new Map                 ()
  droppedPending = 0
  //! rejected — attempts this node ISSUED that were refused TERMINALLY (a relay's validator said no),
  // 'issuer|cid' → the reason it gave. The api's write-outcome join reads it (api/data.ts Bind.sweep)
  // once `rejectedPending` moves — the same counter+probe idiom as droppedPending/committed(). Bounded
  // like the queue (oldest-evicted): an embedder that never consumes reasons (sim, kernel tests) must
  // not grow it forever. A RELAY records nothing here — it hops the refusal onward to its client.
  rejected = new Map                ()
  rejectedPending = 0
  //! released — how many attempts have ever LEFT the queue (WACKed, committed here, dropped, refused): a
  // monotonic counter the api reads to skip work while nothing moved. While it stands still, every
  // attempt the embedder saw queued is still queued (api/data.ts Bind: a foreign row apply asks about
  // our in-flight field writes in that row only when the kernel let one of ours go since it last asked).
  released = 0
  #cid = 0
  //! cid — the attempt counter, read-only (M5a): the embedder samples it around a synchronous write()
  // to learn which cids its batch minted (issue() assigns one per record, contiguous, in record order;
  // the epoch-0 fast path mints none — those records apply synchronously inside the same step instead).
  get cid()         { return this.#cid }
  #queued = 0 // attempts with sent < 0 — lets #drain no-op when everything is in flight
  //! per-issuer dedup window: cid → original commit coordinates, oldest-first (Map order), fed by BOTH
  // the local commit site and replicated attempt identities (the ownership-move exactly-once story)
  // (`o`: the owner of record — the lane the commit was stamped on — when this node can know it: its own
  // commits, replicated records, and a WACK straight from the owner; a spoke's WACK comes via its relay)
  #seen = new Map                                                           ()

  //! issuer — my cid-lane identity: uuid + incarnation, so a restarted node opens a FRESH dedup lane
  // instead of aliasing cids its predecessor already spent (the counter is volatile until M4's boot record).
  issuer(node      )         { return node.uuid + '~' + node.incarnation }

  //! reset — condemn's companion (kernel/node.ts condemn): drop every dedup coordinate learned from a
  // condemned replay. A coordinate kept past the condemned fold would dup-ACK a retry with the stamp of
  // a record that may exist nowhere — silent acknowledged loss. Forgetting is the honest weaker mode:
  // a post-condemn retry re-commits as a same-value LWW supersede until replication re-feeds the window.
  reset() { this.#seen.clear() }

  //! committed — read-only dedup-window probe (M5a): the ORIGINAL commit coordinates of an attempt, if
  // still inside the exact window. The api layer resolves a pending write that committed but never
  // surfaced through its own apply join (the cross-epoch LWW-loss race) from exactly this evidence.
  committed(issuer        , cid        )                                                   {
    return this.#seen.get(issuer)?.get(cid)
  }

  //! issue — source=local: the 'write' event lands here. Epoch 0 + open gate is the M0/M1 fast path
  // (straight to the stamp site, zero attempt bookkeeping); everything else mints Attempts and drains.
  issue(node      , recs       ) {
    //! a CLIENT never takes the fast path and never stamps: every attempt is minted at ae=0 (the
    // client marker, plan §5) and relayed by the primary — the relay re-stamps at arrival (M5b)
    if (!node.client && node.membership.view.epoch === 0 && node.membership.gate(node).open) {
      if (this.pending.size) this.#drain(node) // older parked attempts keep issue order ahead of this batch
      node.commit(recs)
      return
    }
    const me = this.issuer(node)
    for (const rec of recs)
      this.#enqueue(node, { cid: ++this.#cid, ae: node.client ? 0 : node.epoch, issuer: me, rec, via: -1, sent: -1, to: '', parked: false })
    this.#drain(node)
  }

  //! flush — the flush boundary (gate transitions, view installs, admits — membership.settle calls this):
  // parked attempts re-enter the world with a REFRESHED attemptEpoch (#drain stamps it; lawful — this
  // node is the issuer or the owning relay of everything in its queue).
  flush(node      ) { this.#drain(node) }

  //! repark — the client-failover companion (M5b, called from node.ts on primary linkDown): put every
  // in-flight attempt back on the queue and re-drain at the NEW primary immediately (not at RETRY_TICKS).
  // Owner-side cid dedup absorbs any duplicate the dead relay already delivered.
  repark(node      ) {
    for (const a of this.pending.values())
      if (a.sent >= 0) { a.sent = -1; a.to = ''; this.#queued++ }
    this.#drain(node)
  }

  //! tick — the retry clock (heartbeat): an in-flight attempt whose ACK/NACK never arrived re-parks after
  // RETRY_TICKS and the drain re-resolves + re-forwards it. Covers lost WRITE, lost ACK, a dead owner
  // (the view eventually evicts it; the re-resolve then targets the new owner) — and paces NACK retries
  // (onNack re-parks onto THIS clock, never straight back onto the wire). Dedup absorbs every duplicate.
  tick(node      ) {
    if (this.pending.size === 0) return
    const retry = node.tune.retryTicks
    for (const a of this.pending.values())
      if (a.sent >= 0 && ++a.sent >= retry) { a.sent = -1; this.#queued++ }
    this.#drain(node)
  }

  //! #enqueue — into the ONE bounded queue; overflow drops the OLDEST attempt (surfaced counter + journal).
  // A same-key re-enqueue (a client retransmitting a still-pending attempt) REPLACES the entry (idempotent).
  #enqueue(node      , a         ) {
    const key = a.issuer + '|' + a.cid
    const old = this.pending.get(key)
    if (old && old.sent < 0) this.#queued--
    this.pending.set(key, a)
    this.#queued++
    if (this.pending.size > node.tune.pending) {
      const oldest = this.pending.keys().next().value 
      const dropped = this.pending.get(oldest) 
      this.pending.delete(oldest)
      if (dropped.sent < 0) this.#queued--
      this.droppedPending++
      this.released++
      node.journal.armed && node.journal.emit(JK.writeBufferDrop, this.droppedPending)
    }
  }

  //! #drain — the ONE mover: walk parked attempts in issue order; commit the self-owned ones (this is
  // the flush-boundary re-validation: ownership is re-resolved against the CURRENT ring, so a write
  // parked before an ownership move forwards to the new owner instead of stamping locally — AA #3's
  // fix), forward the rest to their owners. A closed gate parks everything: minority/evicted/stale/
  // rejoining nodes move nothing until settle reopens (M2's CP semantics, kept — and while stale or
  // rejoining the local ring is untrustworthy anyway).
  #drain(node      ) {
    if (this.#queued === 0) return
    const j = node.journal
    //! CLIENT drain (M5b): no gate, no ring — the primary link is the route for EVERYTHING queued
    // (the relay owns ownership resolution, gating, and NACK re-drives). No primary ⇒ park; the
    // failover path (node.ts linkDown) reparks in-flight attempts and re-drains at the new relay.
    if (node.client) {
      const id = node.primary
      const link = id !== null ? node.links.get(id) : undefined
      if (!link || link.state !== LS.admitted || link.dead) {
        for (const a of this.pending.values())
          if (!a.parked && a.sent < 0) { a.parked = true; j.armed && j.emit(JK.writeBuffered, this.pending.size) }
        return
      }
      let list                   = null
      for (const a of this.pending.values())
        if (a.sent < 0) (list ??= []).push(a)
      if (!list) return
      for (const a of list) { a.sent = 0; a.to = link.uuid; a.parked = false; this.#queued-- }
      const batch = list.map((a) => ({ rec: a.rec, origin: a.issuer, seq: a.cid, epoch: 0 }))
      for (const bytes of encodeRuns(batch, VERB.WRITE)) link.ship(bytes, node.env.sink, j)
      j.armed && j.emit(JK.writeForward, link.uuid, list[0].cid, list.length)
      return
    }
    if (!node.membership.gate(node).open) {
      for (const a of this.pending.values())
        if (!a.parked && a.sent < 0) { a.parked = true; j.armed && j.emit(JK.writeBuffered, this.pending.size) }
      return
    }
    const epoch = node.membership.view.epoch
    if (this.ring.epoch !== epoch) this.ring.build(epoch, node.membership.view.members)
    let commits                   = null
    let runs                              = null
    for (const a of this.pending.values()) {
      if (a.sent >= 0) continue
      const owner = epoch === 0 ? node.uuid : this.ring.ownerOf(partitionOf(a.rec))
      if (owner === node.uuid || owner === '') {
        //! M6 [finding 27]: an ORPHAN-FROZEN partition must not accept new stamps — the freeze
        // invariant ("an orphan's floors never advance") holds at the stamp site too. The attempt
        // PARKS; the retry clock re-drains it after the re-entry latch (rescope's orphan-reassigned
        // leg) transitions the partition back to held. Acquiring is deliberately NOT parked: the
        // mid-latch owner commit is lawful single-writer data (staged live replays over it).
        if (node.armed && node.scope .entries.get(partitionOf(a.rec))?.state === SCOPE.orphan) {
          if (!a.parked) { a.parked = true; j.armed && j.emit(JK.writeBuffered, this.pending.size) }
          continue
        }
        a.ae = epoch // the issuer/flush-boundary re-stamp (the ONLY lawful site besides relay arrival)
        ;(commits ??= []).push(a)
        continue
      }
      const id = node.byUuid.get(owner)
      const link = id !== undefined ? node.links.get(id) : undefined
      if (!link || link.state !== LS.admitted || link.dead) {
        if (!a.parked) { a.parked = true; j.armed && j.emit(JK.writeBuffered, this.pending.size) }
        continue
      }
      a.ae = epoch
      runs ??= new Map()
      let list = runs.get(link)
      if (!list) { list = []; runs.set(link, list) }
      list.push(a)
    }
    if (commits) this.#commit(node, commits)
    if (runs)
      for (const [link, list] of runs) {
        for (const a of list) { a.sent = 0; a.to = link.uuid; a.parked = false; this.#queued-- }
        const batch = list.map((a) => ({ rec: a.rec, origin: a.issuer, seq: a.cid, epoch: a.ae }))
        for (const bytes of encodeRuns(batch, VERB.WRITE)) link.ship(bytes, node.env.sink, j)
        j.armed && j.emit(JK.writeForward, link.uuid, list[0].cid, list.length)
      }
  }

  //! #commit — the stamp site's doorman for ATTEMPTS: dedup (issuer lane), then node.commit() stamps
  // {origin: me, seq: ++lamport, epoch: committed} in contiguous runs WITH the attempt identity attached
  // (logged + broadcast — replication feeds every node's window), then ACK bookkeeping (wire ACKs for
  // relayed attempts; locally-issued ones just leave the queue — replication is their ACK).
  #commit(node      , list           ) {
    const j = node.journal
    const me = this.issuer(node)
    for (let i = 0; i < list.length; ) {
      const a = list[i]
      //! duplicate: re-answer with the ORIGINAL coordinates (exactly-once at the commit site)
      if (a.issuer !== me) {
        const hit = this.#seen.get(a.issuer)?.get(a.cid)
        if (hit) {
          j.armed && j.emit(JK.writeDup, a.issuer, a.cid)
          this.#ack(node, a.via, { u: a.issuer, c: a.cid, n: 1, s: hit.s, e: hit.e })
          this.#remove(a)
          i++
          continue
        }
      }
      //! contiguous same-issuer same-route cid run → one node.commit batch → one contiguous seq run → one ACK
      let jEnd = i + 1
      while (jEnd < list.length && list[jEnd].issuer === a.issuer && list[jEnd].via === a.via &&
             list[jEnd].cid === a.cid + (jEnd - i) &&
             !(list[jEnd].issuer !== me && this.#seen.get(list[jEnd].issuer)?.has(list[jEnd].cid))) jEnd++
      const run = list.slice(i, jEnd)
      const s0 = node.commit(run.map((x) => x.rec), { issuer: a.issuer, baseCid: a.cid })
      for (let k = 0; k < run.length; k++) {
        const x = run[k]
        this.#remember(node, x.issuer, x.cid, s0 + k, node.epoch, node.uuid)
        this.#remove(x)
      }
      this.#ack(node, a.via, { u: a.issuer, c: a.cid, n: run.length, s: s0, e: node.epoch })
      i = jEnd
    }
  }

  //! #remove — drop an attempt from the queue with counter bookkeeping (no-op for never-queued attempts).
  #remove(a         ) {
    if (this.pending.delete(a.issuer + '|' + a.cid)) { this.released++; if (a.sent < 0) this.#queued-- }
  }

  //! #remember — record a committed cid in the issuer's exact dedup window (oldest-first eviction), with
  // the lane count itself bounded: the oldest LANE evicts (journal-surfaced) past MAX_ISSUERS.
  #remember(node      , issuer        , cid        , s        , e        , o         ) {
    let lane = this.#seen.get(issuer)
    if (!lane) {
      lane = new Map()
      this.#seen.set(issuer, lane)
      if (this.#seen.size > node.tune.issuers) {
        const oldest = this.#seen.keys().next().value 
        this.#seen.delete(oldest)
        node.journal.armed && node.journal.emit(JK.dedupEvict, oldest)
      }
    }
    lane.set(cid, o === undefined ? { s, e } : { s, e, o })
    if (lane.size > node.tune.dedupKeep) lane.delete(lane.keys().next().value )
  }

  //! remember — the ACQ-fold's doorway into the dedup window (M6): acquired records carry attempt
  // identity exactly like AE re-ships, so a healed-or-future owner rebuilds exactly-once from the
  // transfer itself (the M3 ownership-move story, kept across acquisition).
  remember(node      , issuer        , cid        , s        , e        ) { this.#remember(node, issuer, cid, s, e) }

  //! #ack — WACK on the reply route (`via` link) for relayed/forwarded attempts; via -1 = locally issued, no frame.
  #ack(node      , via        , v                                                           ) {
    if (via < 0) return
    const link = node.links.get(via)
    if (!link || link.dead) return // the asker is gone; its retransmit will hit the dedup window instead
    link.ship(encodeControl(VERB.WACK, v), node.env.sink, node.journal)
  }

  //! #nack — WNACK on a reply route (`via` link): the onward hop of a terminal `invalid` at a relay. The
  // asker being gone is not an error — its retransmit would meet the same validator again.
  #nack(node      , via        , v                                                                       ) {
    const link = node.links.get(via)
    if (!link || link.dead) return
    link.ship(encodeControl(VERB.WNACK, v), node.env.sink, node.journal)
  }

  //! onWrite — source=forwarded (and the client relay rule): a WRITE frame's provenance triple is the
  // attempt triple [issuer, baseCid, attemptEpoch]. A CLIENT attempt — ae 0, the marker an honest spoke
  // always sends, OR any WRITE arriving on a link admitted as a client (HELLO r:1): the relay is keyed on
  // the server's ADMISSION FACT, never on the sender's claim, so a forged ae cannot slip a client past
  // the relay into the owner leg — this server becomes the relay: stamps ae (relay time is an issuer
  // boundary), validates, queues with the reply route, and owns re-resolution from here. ae > 0 from a
  // member is the owner-validation ingress: dedup → validate → commit or WNACK.
  onWrite(node      , link      , f       ) {
    const j = node.journal
    const prov = f.prov()
    if (!prov) { j.armed && j.emit(JK.frameDrop, link.id, 'write without attempt triple'); return }
    const { origin: issuer, baseSeq: c0, epoch: ae } = prov
    if (ae === 0 || link.client) {
      j.armed && j.emit(JK.writeRelay, issuer, c0)
      const validate = node.validate
      let i = 0
      //! no predicate: the pre-validation loop, byte-for-byte (one undefined-check per frame is the
      // whole cost — no closure, no compare, trajectories identical)
      if (validate === undefined) {
        for (const rv of f.records())
          this.#enqueue(node, { cid: c0 + i++, ae: node.epoch, issuer, rec: rv.rec(), via: link.id, sent: -1, to: '', parked: false })
        this.#drain(node)
        return
      }
      //! the relay VALIDATES (2026-09-05): relay time IS an issuer boundary, so the server's admission
      // predicate (NodeOpts.validate — the api's seams.validation) runs here exactly as it does on the
      // server's own issues (api/data.ts issue). A refused record never enters the queue: it WNACKs
      // `invalid` with the reason, batched per contiguous same-reason run like every other NACK. A cid
      // already in the dedup window SKIPS the check — it committed once (so it passed once), and a
      // state-dependent predicate must not turn a retransmit of a committed record into a lie; the
      // ordinary path below dup-ACKs it with its original coordinates.
      let nack                                             = null
      const flushNack = () => {
        if (!nack) return
        j.armed && j.emit(JK.writeNack, NACK.invalid, node.epoch, nack.c)
        link.ship(encodeControl(VERB.WNACK, { u: issuer, c: nack.c, n: nack.n, r: NACK.invalid, m: nack.m, ce: node.epoch }), node.env.sink, j)
        nack = null
      }
      for (const rv of f.records()) {
        const cid = c0 + i++
        const rec = rv.rec()
        if (!this.#seen.get(issuer)?.has(cid)) {
          const v = validate(rec)
          if (v !== true) {
            const m = String(v).slice(0, REASON_MAX)
            if (nack && (nack.m !== m || nack.c + nack.n !== cid)) flushNack()
            nack ? nack.n++ : (nack = { m, c: cid, n: 1 })
            continue
          }
        }
        flushNack()
        this.#enqueue(node, { cid, ae: node.epoch, issuer, rec, via: link.id, sent: -1, to: '', parked: false })
      }
      flushNack()
      this.#drain(node)
      return
    }
    //! an attemptEpoch above my committed view is proof that view committed somewhere — the M2 staleness
    // contract applies to attempts exactly as it does to records
    if (ae > node.epoch) node.membership.staleObserved(node, ae, link)
    const gate = node.membership.gate(node)
    const epoch = node.membership.view.epoch
    if (this.ring.epoch !== epoch && epoch > 0) this.ring.build(epoch, node.membership.view.members)
    //! walk the run, grouping contiguous same-outcome records: commits batch into Attempts for #commit;
    // rejects batch into one WNACK per contiguous reason run. Validation order: epoch first (a stale
    // party makes the owner test meaningless), then ownership, then the gate. The dedup PRE-FILTER runs
    // before validation on purpose: a retransmit of a committed cid must dup-ACK its original
    // coordinates even when the CURRENT epoch/ring/gate would reject it as fresh work.
    let i = 0
    let commits                   = null
    let nack                                             = null
    const flushNack = () => {
      if (!nack) return
      j.armed && j.emit(JK.writeNack, nack.r, node.epoch, nack.c)
      link.ship(encodeControl(VERB.WNACK, { u: issuer, c: nack.c, n: nack.n, r: nack.r, ce: node.epoch }), node.env.sink, j)
      nack = null
    }
    for (const rv of f.records()) {
      const cid = c0 + i++
      const dup = this.#seen.get(issuer)?.get(cid)
      if (dup) {
        flushNack()
        j.armed && j.emit(JK.writeDup, issuer, cid)
        this.#ack(node, link.id, { u: issuer, c: cid, n: 1, s: dup.s, e: dup.e })
        continue
      }
      const reason =
        ae !== node.epoch || epoch === 0 ? NACK.staleEpoch
        : !this.ring.holds(node.uuid, partitionOf(rv)) ? NACK.notOwner
        : !gate.open ? NACK.withheld
        //! M6 [finding 27]: owner-by-ring but ORPHAN-frozen (re-assignment pending its re-entry
        // latch) — withheld is the honest retryable answer; the issuer's retry clock re-forwards
        // after the latch completes. Acquiring commits stay lawful (mid-latch owner writes).
        : node.armed && node.scope .entries.get(partitionOf(rv))?.state === SCOPE.orphan ? NACK.withheld
        : ''
      if (reason) {
        if (nack && (nack.r !== reason || nack.c + nack.n !== cid)) flushNack()
        nack ? nack.n++ : (nack = { r: reason, c: cid, n: 1 })
        continue
      }
      flushNack()
      ;(commits ??= []).push({ cid, ae, issuer, rec: rv.rec(), via: link.id, sent: -1, to: '', parked: false })
    }
    flushNack()
    if (commits) this.#commit(node, commits)
  }

  //! onAck — commit coordinates arrived FROM THE OWNER OF RECORD: clear the pending attempts; a RELAY
  // batches the coordinates onward per contiguous run toward the client (`via`) — one WACK in, one WACK
  // out (the review measured the previous per-cid fan-out at n frames + n allocations per batch).
  onAck(node      , link      , v                                                                     ) {
    if (typeof v?.u !== 'string' || typeof v.c !== 'number' || typeof v.n !== 'number' || v.n <= 0 || v.n > MAX_RUN) return
    if (typeof v.s !== 'number' || typeof v.e !== 'number') return // coordinates hop onward to relays — garbage must not
    const j = node.journal
    let hop                                                          = null
    const flushHop = () => {
      if (!hop) return
      this.#ack(node, hop.via, { u: v.u          , c: hop.c, n: hop.n, s: hop.s, e: v.e           })
      hop = null
    }
    //! the journal row names what this WACK actually CLEARED (first cid, count) — not what it carried. The
    // same commit reaches an issuer twice, as the replicated record with its attempt identity (the
    // replication-IS-an-ACK path below) and as this frame; whichever lands second clears nothing, and a
    // row for it would count one write as two acks (a diary reader did — IDEAS 2026-09-28).
    let cleared = 0, first = -1
    for (let i = 0; i < v.n; i++) {
      const key = v.u + '|' + (v.c + i)
      const a = this.pending.get(key)
      if (!a || (a.to && a.to !== link.uuid)) { flushHop(); continue } // not ours to clear / not the owner of record
      if (a.via >= 0) {
        if (hop && (hop.via !== a.via || hop.c + hop.n !== v.c + i)) flushHop()
        hop ? (hop.n++) : (hop = { via: a.via, c: v.c + i, n: 1, s: v.s + i })
      }
      if (a.sent < 0) this.#queued--
      this.pending.delete(key)
      this.released++
      if (cleared++ === 0) first = v.c + i
      //! the WACK's coordinates feed the dedup window too (M5b): they ARE the original commit
      // coordinates, from the owner of record. This closes the WACK-before-replication window where a
      // cleared attempt had no committed() evidence — the api's drop-sweep (and any dup arriving before
      // the record replicates back) reads the answer from here.
      this.#remember(node, v.u, v.c + i, v.s + i, v.e, node.client ? undefined : link.uuid) // a member's WACK comes from the owner
    }
    flushHop()
    if (cleared) j.armed && j.emit(JK.writeAck, v.u, first, cleared)
  }

  //! onNack — typed rejection FROM THE OWNER OF RECORD: journal it, absorb the staleness evidence (ce),
  // and re-drive — onto the TICK CLOCK for same-epoch reasons (withheld/not-owner: re-forwarding
  // instantly just re-manufactures the same answer at line rate — the review's storm), or parked for
  // the next flush boundary when ce reveals a newer view (the install is the fresh routing state that
  // makes an immediate retry meaningful). The relay owns re-resolution for client attempts identically.
  onNack(node      , link      , v                                                                                   ) {
    if (typeof v?.u !== 'string' || typeof v.c !== 'number' || typeof v.n !== 'number' || v.n <= 0 || v.n > MAX_RUN) return
    const j = node.journal
    j.armed && j.emit(JK.writeNack, typeof v.r === 'string' ? v.r : '?', typeof v.ce === 'number' ? v.ce : -1, v.c)
    const newer = typeof v.ce === 'number' && v.ce > node.epoch
    if (newer) node.membership.staleObserved(node, v.ce          , link)
    //! `invalid` is TERMINAL (the relay's validator refused the record — a retry re-manufactures the
    // same answer): the attempt leaves the queue for good. Still owner-of-record gated like every
    // ACK/NACK. A RELAY hops the refusal onward to its client (via ≥ 0 — batched per contiguous run
    // like onAck's hop; the reason text travels verbatim); the ISSUER records the reason under the
    // attempt key and bumps rejectedPending for the api's outcome join (api/data.ts Bind.sweep).
    // Only an issuer boundary ever refuses, so a relay hearing `invalid` from an owner is a defensive
    // path — handled honestly rather than retried against an answer that cannot change.
    if (v.r === NACK.invalid) {
      const m = typeof v.m === 'string' ? v.m : NACK.invalid
      let hop                                               = null
      const flushHop = () => {
        if (!hop) return
        this.#nack(node, hop.via, { u: v.u          , c: hop.c, n: hop.n, r: NACK.invalid, m, ce: node.epoch })
        hop = null
      }
      for (let i = 0; i < v.n; i++) {
        const key = v.u + '|' + (v.c + i)
        const a = this.pending.get(key)
        if (!a || (a.to && a.to !== link.uuid)) { flushHop(); continue }
        if (a.via >= 0) {
          if (hop && (hop.via !== a.via || hop.c + hop.n !== v.c + i)) flushHop()
          hop ? hop.n++ : (hop = { via: a.via, c: v.c + i, n: 1 })
        } else {
          this.rejected.set(key, m)
          if (this.rejected.size > node.tune.pending) this.rejected.delete(this.rejected.keys().next().value )
          this.rejectedPending++
        }
        this.#remove(a)
      }
      flushHop()
      return
    }
    for (let i = 0; i < v.n; i++) {
      const a = this.pending.get(v.u + '|' + (v.c + i))
      if (!a || (a.to && a.to !== link.uuid)) continue // only the owner of record may re-drive the route
      if (newer) { if (a.sent >= 0) { a.sent = -1; this.#queued++ } }
      else a.sent = 0 // paced: the tick clock re-parks after RETRY_TICKS
    }
  }

  //! inbound — source=inbound (moved verbatim from M1's node.#ingest): gap-tolerant monotone dedup,
  // then the LWW election in node.apply. OWN-ORIGIN echoes are special-cased: an echo AT OR BELOW the
  // own log tail is dropped (the seed-79 class — a digest-snapshot race echoing our records back once
  // appended duplicates OUT OF ORDER, breaking the AE suffix walk), but an echo BEYOND the tail is
  // ingested append-ascending — after a crash whose disk lied or tore, our lost-but-replicated records
  // come back from peers exactly this way (M4b's fsync-lie schedule proved the blanket guard turned
  // recoverable loss into permanent self-amnesia). Appends stay ascending by construction (tail check),
  // and the link machinery's pure-tail-loss guarantee means no interior holes — the same argument every
  // other stream rests on. (An admitted peer could forge beyond-tail records under our origin; admitted
  // peers are trusted at this layer — the M7 auth story bounds who is admitted.)
  // A record carrying ATTEMPT IDENTITY feeds the local cid-dedup window (the ownership-move story) and
  // doubles as an ACK: it clears a matching pending attempt and hops coordinates to a relayed client.
  // Returns the freshness FLAVOR: 0 = duplicate (nothing changed), 1 = fresh APPEND (WAL-safe — the
  // caller may persistRun the frame), 2 = fresh SPLICE (M6 dual fence: folded and logged, but must
  // NEVER ride persistRun — an interior row would walk walTail backwards and condemn the chain on
  // replay; it reaches disk only via the next snapshot() swap — DESIGN-M6 §0 no-interior-rows).
  inbound(node      , origin        , seq        , epoch        , rv                                                          )         {
    const j = node.journal
    //! the Lamport merge-up runs first, even for drops: the clock must track everything observed —
    // a reborn clock re-issuing a lost stamp would corrupt provenance cluster-wide.
    if (seq > node.seq) node.seq = seq
    //! NO own-lane special case since M4a: the stamp site advances the own applied watermark, so the
    // general dedup below already drops under-tail echoes of the CURRENT lane (the seed-79 poisoning).
    // A PREVIOUS life's lane (uuid vs uuid~inc) is an ordinary foreign stream here — immutable,
    // tail-complete at peers, healed by suffix AE like anything else (the M4b recovery story).
    const d = node.streams.for(origin)
    //! M6 INBOUND GATE (armed only, the §0 law's first row): a record for a partition this node
    // neither holds nor is assigned — or holds only as a FROZEN ORPHAN — drops before the fence.
    // It exists for the one lawful race (a sender fanning out on an older epoch's ring) and can never
    // forge evidence (the dropper never attests marks for p) or strand data (the true holders receive
    // it from the sender directly; a committer's own copy survives until shed). The rec materializes
    // early here (armed only — the gate needs the partition before the fence can run).
    let rec             = null
    if (node.armed) {
      rec = rv.rec()
      const p = partitionOf(rec)
      const verdict = node.scope .verdict(node, p)
      if (verdict === 0) { j.armed && j.emit(JK.gateDrop, origin, seq); return 0 }
      if (verdict === 2) {
        //! an open latch: live records for the acquiring partition STAGE — nothing touches lanes,
        // floors, or the fence until the fold (§0 law row 2; ACQDONE replays this span). The pp
        // rides the buffer so the replayed span keeps its chain evidence.
        node.scope .stage(node, p, origin, seq, epoch, rec, rv.issuer || undefined, rv.issuer ? rv.cid : undefined, rv.pp)
        return 0
      }
    }
    //! the APPLIED watermark advances at the dedup decision (LWW losers included — losing is not loss).
    // The scalar fence's license is "FIFO link × single broadcaster" — under M6 scoping one lane's
    // records reach a node from MULTIPLE answerers holding different partition subsets, so an
    // under-fence arrival may be an INTERIOR record, not a duplicate: the armed path falls through to
    // the dual fence (DESIGN-M6 §0) instead of dropping. A CLIENT takes the same path — its feeder is
    // one FIFO link, but a SCOPED feeder legitimately re-forwards its own splices out of seq order
    // (on unscoped trajectories a client's under-fence arrival is always a genuine dup, which the
    // dual fence answers identically: found-in-lane ⇒ drop — zero behavioural change).
    if (seq <= d.applied) {
      if (node.armed || node.client) return this.#splice(node, origin, seq, epoch, rv, d, rec)
      j.armed && j.emit(JK.dupDrop, origin, seq); return 0
    }
    d.applied = seq
    if (rec === null) rec = rv.rec() // ONE copy out of the receive chunk, shared by the log entry and the apply
    const entry                                                                                    = { rec, seq, epoch }
    if (rv.issuer) { entry.iss = rv.issuer; entry.cid = rv.cid }
    if (node.armed && rv.pp !== undefined && rv.pp >= 0) entry.pp = rv.pp
    node.logFor(origin).push(entry)
    //! the SHIPPABLE watermark advances at the log append — the sole evidence confirm:'replicated'
    // may ever read (M4c); synchronous with applied today, a distinct site by design
    d.shippable = seq
    //! M6 possession floor (armed only) — THE CHAIN RULE (the review's floor law, findings
    // 10/18/25): advance to seq ONLY when the current floor already covers the sender-stamped
    // predecessor (`pp >= 0 && pp <= pe.s`). "Single-source ascending delivery" was the old
    // license and it is locally unverifiable — a mid-lane first arrival, an AE re-admit race, or
    // two senders serving one lane all delivered a seq above an interior the node never received,
    // and the eager advance FORGED coverage the shed predicate then destroyed data on. A gapped
    // record still folds (the lane keeps it); the floor waits for the handshake latch's attested
    // cut. Unknown pp (-1: pre-pp history, epoch-0 rows) fails CLOSED. The partition also lands in
    // the caller's per-frame scratch — the persistRun batch records per-partition maxes so the
    // persisted echo can advance the DURABLE floors it actually covers (capped at pe.s there).
    if (node.armed) {
      const p = partitionOf(rec)
      const pe = d.part(p)
      const pp = rv.pp ?? -1
      if (pp >= 0 && pp <= pe.s && seq > pe.s) pe.s = seq
      if (this.rxParts) { const m = this.rxParts.get(p); if (m === undefined || seq > m) this.rxParts.set(p, seq) }
    }
    node.apply(rec, origin, seq, epoch, entry.iss, entry.cid)
    j.armed && j.emit(JK.applyInbound, origin, seq)
    //! the spoke feed (M5b): fresh inbound records re-ship to synced CLIENT links — a spoke hears every
    // origin lane through its ONE primary (members still never re-broadcast to members). Same records,
    // same order (this loop runs per fresh record, in arrival order), attempt identity intact (the
    // client's write-route join reads it). Flushed once per frame by the RECORDS handler.
    if (node.clientLinks.size)
      for (const cl of node.clientLinks)
        if (cl.state === LS.admitted && cl.synced && !cl.dead)
          cl.add(rec, { origin, baseSeq: seq, epoch }, rv.issuer ? { issuer: rv.issuer, baseCid: rv.cid } : undefined)
    if (rv.issuer) {
      this.#remember(node, rv.issuer, rv.cid, seq, epoch, origin)
      const a = this.pending.get(rv.issuer + '|' + rv.cid)
      if (a) {
        //! replication IS an ACK: the commit is visible with its coordinates — clear the route
        j.armed && j.emit(JK.writeAck, rv.issuer, rv.cid, 1)
        if (a.via >= 0) this.#ack(node, a.via, { u: rv.issuer, c: rv.cid, n: 1, s: seq, e: epoch })
        this.#remove(a)
      }
    }
    return 1
  }

  //! rxParts — the RECORDS handler's per-frame scratch (armed only): partition → max fresh APPEND seq
  // in the frame, feeding persistRun's per-partition batch cover. Null unscoped (zero fast-path cost).
  rxParts                             = null

  //! #splice — the DUAL FENCE (M6, DESIGN-M6 §0): an under-fence arrival on an ARMED node may be an
  // INTERIOR record, not a duplicate — under scoping one lane's records reach a node from multiple
  // answerers holding different partition subsets, so cross-link interleave lawfully delivers a seq
  // below the scalar fence that this node has never seen. The decision ladder:
  //   seq ≤ possession floor  → drop (genuine dup, or effect lawfully compacted-because-covered)
  //   present in the lane     → drop (genuine dup above the floor — e.g. pre-floor history)
  //   absent                  → SPLICE at seq position (the lane stays ascending for the AE walk and
  //                             compaction), fold through the one LWW election, advance the floor.
  // A CLIENT rides the same path with floor 0 forever (it attests nothing): its single scoped feeder
  // legitimately re-forwards its own splices out of seq order, and on unscoped trajectories every
  // under-fence arrival is a genuine dup that the lane-presence test drops identically.
  // Durable nodes: the splice is MEMORY-ONLY here — node.spliced() marks the partition dirty and arms
  // the snapshot swap; until the swap's echo the durable floor does not cover it (no-interior-rows).
  #splice(node      , origin        , seq        , epoch        , rv                                                          , d                  , pre             = null)         {
    const j = node.journal
    //! [finding 45] the CLIENT leg (pre === null: unarmed, no gate ran) defers materialising the
    // record until the lane-presence test proves it fresh — on unscoped trajectories every
    // under-fence arrival is a genuine dup, and decoding it just to drop it was a per-dup
    // allocation the old scalar fence never paid.
    let rec = pre
    if (node.armed && rec !== null && (d.parts?.get(partitionOf(rec))?.s ?? 0) >= seq) { j.armed && j.emit(JK.dupDrop, origin, seq); return 0 }
    const lane = node.logFor(origin)
    let lo = 0, hi = lane.length
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (lane[mid].seq < seq) lo = mid + 1; else hi = mid }
    if (lo < lane.length && lane[lo].seq === seq) { j.armed && j.emit(JK.dupDrop, origin, seq); return 0 }
    if (rec === null) rec = rv.rec()
    const p = partitionOf(rec)
    const entry                                                                                    = { rec, seq, epoch }
    if (rv.issuer) { entry.iss = rv.issuer; entry.cid = rv.cid }
    if (node.armed && rv.pp !== undefined && rv.pp >= 0) entry.pp = rv.pp
    lane.splice(lo, 0, entry) // ascending preserved: inserted at its seq position
    if (node.armed) {
      const pe = d.part(p)
      //! the chain rule at the splice site, PLUS the forward walk: a gap-fill can make later
      // already-folded (o,p) entries contiguous — advance through every one that now chains
      // (each stored pp verified), stopping at the first remaining gap. Splices are rare heal
      // events; the walk is bounded by the lane suffix and usually a few steps.
      const pp = rv.pp ?? -1
      if (pp >= 0 && pp <= pe.s) {
        if (seq > pe.s) pe.s = seq
        for (let i = lo + 1; i < lane.length; i++) {
          const en = lane[i]
          if (partitionOf(en.rec) !== p) continue
          if (en.pp !== undefined && en.pp >= 0 && en.pp <= pe.s) { if (en.seq > pe.s) pe.s = en.seq }
          else break
        }
      }
      node.spliced(p) // durable bookkeeping: dirty partition + snapshot arming (no-op non-durable)
    }
    node.apply(rec, origin, seq, epoch, entry.iss, entry.cid)
    j.armed && j.emit(JK.applyInbound, origin, seq)
    //! the spoke feed sees splices too — same fresh-ingest contract as the fast path; the spoke's own
    // dual fence (the client leg above) accepts the interior on its side
    if (node.clientLinks.size)
      for (const cl of node.clientLinks)
        if (cl.state === LS.admitted && cl.synced && !cl.dead)
          cl.add(rec, { origin, baseSeq: seq, epoch }, rv.issuer ? { issuer: rv.issuer, baseCid: rv.cid } : undefined)
    if (rv.issuer) {
      this.#remember(node, rv.issuer, rv.cid, seq, epoch, origin)
      const a = this.pending.get(rv.issuer + '|' + rv.cid)
      if (a) {
        j.armed && j.emit(JK.writeAck, rv.issuer, rv.cid, 1)
        if (a.via >= 0) this.#ack(node, a.via, { u: rv.issuer, c: rv.cid, n: 1, s: seq, e: epoch })
        this.#remove(a)
      }
    }
    return 2
  }

  //! replay — source=replay (M4b): a WAL row re-ingested at boot, before the network exists. Everything
  // a replayed record proves is durable by definition (it was just read from disk), so the whole ladder
  // advances: applied, shippable, AND durable. Attempt identities re-feed the dedup window, so a
  // restarted owner still dedups pre-crash retries. THE CHAIN CHECK: a row whose `prev` link does not
  // match the origin's replayed tail sits past an INTERIOR hole — a lying disk dropped something before
  // it (indistinguishable by seqs alone: Lamport streams are legitimately gappy; honest crashes tear
  // TAILS, never interiors — the shell's ordered io-queue and the sim's FIFO fsync clock guarantee
  // resolution order = append order). A hole therefore PROVES the disk lied, and the fsyncgate verdict
  // is total: node.condemn() resets the fold, ignores the rest of the file, swaps the WAL clean, and
  // the cluster re-teaches this node from scratch (M4e — a liar's prefix kept alive resurrected cells
  // whose removes had been compacted away cluster-wide on this disk's own durable claims).
  replay(node      , f       , prev        ) {
    if (node.tainted) return // condemned: nothing further on this disk is evidence
    const prov = f.prov()
    if (!prov) return // the WAL holds RECORDS-shaped frames only; anything else is not ours to guess at
    const j = node.journal
    if (prev !== (node.walTail.get(prov.origin) ?? 0)) {
      j.armed && j.emit(JK.walHole, prov.origin, prev)
      node.condemn(prov.origin)
      return
    }
    const d = node.streams.for(prov.origin)
    let count = 0
    for (const rv of f.records()) {
      if (rv.seq > node.seq) node.seq = rv.seq // the Lamport clock rebuilds from every replayed stamp
      if (node.armed) {
        //! M6 armed replay (DESIGN-M6 §0/C10) — three departures from the scalar path, all disk-only:
        //   1. the BOOT HELD-GATE: a row record whose partition this life neither holds (boot record)
        //      nor is assigned (restored ring) skips the fold and the floors but still advances
        //      `applied` and the chain — it was fresh at persist time and counted in the row's chain
        //      link, so skipping the advance would false-positive the walHole detector on rows
        //      persisted before a shed.
        //   2. the REPLAY DUAL FENCE: an under-applied record ABSENT from the lane is an interior a
        //      mixed row captured (the live splice was WAL'd inside a later frame) — recover it.
        //   3. FLOOR REBUILD: possession/durable floors rebuild from row maxes — except partitions
        //      the boot record marked DIRTY (a live splice never reached disk: row maxes would
        //      overclaim the hole), which stay at 0 and re-heal via the handshake, honestly low.
        const rec = rv.rec()
        const p = partitionOf(rec)
        if (!node.replayHeld(p, prov.origin)) {
          if (rv.seq > d.applied) d.applied = rv.seq
          continue
        }
        if (rv.seq <= d.applied) {
          const lane = node.logFor(prov.origin)
          let lo = 0, hi = lane.length
          while (lo < hi) { const mid = (lo + hi) >>> 1; if (lane[mid].seq < rv.seq) lo = mid + 1; else hi = mid }
          if (lo < lane.length && lane[lo].seq === rv.seq) continue // duplicate WAL row — re-dedup
          const entry                                                                                    = { rec, seq: rv.seq, epoch: rv.epoch }
          if (rv.issuer) { entry.iss = rv.issuer; entry.cid = rv.cid }
          if (rv.pp >= 0) entry.pp = rv.pp
          lane.splice(lo, 0, entry)
        } else {
          d.applied = rv.seq
          const entry                                                                                    = { rec, seq: rv.seq, epoch: rv.epoch }
          if (rv.issuer) { entry.iss = rv.issuer; entry.cid = rv.cid }
          if (rv.pp >= 0) entry.pp = rv.pp
          node.logFor(prov.origin).push(entry)
          if (rv.seq > d.shippable) d.shippable = rv.seq
          if (rv.seq > d.durable) d.durable = rv.seq
        }
        //! floor rebuild under the CHAIN RULE from the boot-record SEED (the panel's compaction
        // hole): pe.s starts at the last durably-recorded floor (constructor seed — honest-low if
        // stale) and advances only through chain-verified rows, restoring exactly the pre-crash
        // floor — never a row-max claim over a span the rows provably miss. Dirty partitions stay
        // unseeded and unadvanced (honest-low, handshake re-heals), unchanged.
        if (!node.bootDirty.has(p)) {
          const pe = d.part(p)
          if (rv.pp >= 0 && rv.pp <= pe.s && rv.seq > pe.s) { pe.s = rv.seq; pe.d = rv.seq } // disk-proven: possession AND durability
        }
        node.apply(rec, prov.origin, rv.seq, rv.epoch, rv.issuer || undefined, rv.issuer ? rv.cid : undefined)
        j.armed && j.emit(JK.applyInbound, prov.origin, rv.seq)
        if (rv.issuer) this.#remember(node, rv.issuer, rv.cid, rv.seq, rv.epoch)
        count++
        continue
      }
      if (rv.seq <= d.applied) continue // duplicate WAL rows (a re-persisted partially-fresh frame) re-dedup
      d.applied = rv.seq
      const rec = rv.rec()
      const entry                                                                       = { rec, seq: rv.seq, epoch: rv.epoch }
      if (rv.issuer) { entry.iss = rv.issuer; entry.cid = rv.cid }
      node.logFor(prov.origin).push(entry)
      d.shippable = rv.seq
      d.durable = rv.seq
      node.apply(rec, prov.origin, rv.seq, rv.epoch, entry.iss, entry.cid)
      //! replay speaks the SAME journal vocabulary as live ingest (it IS the ingest path): per-record
      // applyInbound keeps the debugger's time-travel fold (tools/debug/model.mjs stateAt) truthful
      // across a restore — without it a reborn node's fold looks empty to every journal consumer.
      j.armed && j.emit(JK.applyInbound, prov.origin, rv.seq)
      if (rv.issuer) this.#remember(node, rv.issuer, rv.cid, rv.seq, rv.epoch)
      count++
    }
    //! the accepted row extends the chain: future persists AND the next row's check link from here
    node.walTail.set(prov.origin, d.applied)
    //! deliberately NOT restored from rows: the committed epoch (boot record only — rows prove data,
    // never views) and pending attempts (a fresh boot has no routes in flight)
    j.armed && j.emit(JK.replayed, count, prov.origin)
  }
}
