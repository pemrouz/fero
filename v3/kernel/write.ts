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

import { VERB, encodeControl, encodeRuns, type Frame } from './codec.ts'
import { Ring } from './ring.ts'
import { JK } from './journal.ts'
import { LS, type Link } from './link.ts'
import { partitionOf, type Rec } from './env.ts'
import type { Node } from './node.ts'

//! MAX_PENDING: the ONE attempt-queue bound (drop-oldest, surfaced) — M2's buffer bound, moved here with the queue.
export const MAX_PENDING = 1024
//! RETRY_TICKS: heartbeat ticks a forwarded attempt waits for its ACK/NACK before re-resolving + re-forwarding.
export const RETRY_TICKS = 2
//! DEDUP_KEEP: committed cids retained per issuer for the exact-window duplicate test + duplicate-ACK coordinates.
export const DEDUP_KEEP = 1024
//! MAX_ISSUERS: dedup lanes retained (oldest-evicted, surfaced) — lanes must not grow with every client that ever wrote.
export const MAX_ISSUERS = 1024

//! NACK: the typed rejection vocabulary (plan §5, verbatim).
export const NACK = { notOwner: 'not-owner', staleEpoch: 'stale-epoch', withheld: 'withheld' } as const

//! Attempt: one record's write-route state, from issue to commit/ACK. `via` is the link to answer on
// for relayed client attempts (-1 = locally issued); `sent` is -1 while parked, else ticks since
// forwarded; `to` is the owner of record — the uuid this attempt was last forwarded to (ACK/NACK
// frames from anyone else are ignored).
interface Attempt {
  cid: number
  ae: number
  issuer: string
  rec: Rec
  via: number
  sent: number
  to: string
  parked: boolean // journaled as buffered once per parking (writeBuffered without the spam)
}

export class Writes {
  ring = new Ring()
  //! the ONE bounded queue — key `issuer|cid`, insertion order preserved (issue order per issuer)
  pending = new Map<string, Attempt>()
  droppedPending = 0
  #cid = 0
  #queued = 0 // attempts with sent < 0 — lets #drain no-op when everything is in flight
  //! per-issuer dedup window: cid → original commit coordinates, oldest-first (Map order), fed by BOTH
  // the local commit site and replicated attempt identities (the ownership-move exactly-once story)
  #seen = new Map<string, Map<number, { s: number; e: number }>>()

  //! issuer — my cid-lane identity: uuid + incarnation, so a restarted node opens a FRESH dedup lane
  // instead of aliasing cids its predecessor already spent (the counter is volatile until M4's boot record).
  issuer(node: Node): string { return node.uuid + '~' + node.incarnation }

  //! issue — source=local: the 'write' event lands here. Epoch 0 + open gate is the M0/M1 fast path
  // (straight to the stamp site, zero attempt bookkeeping); everything else mints Attempts and drains.
  issue(node: Node, recs: Rec[]) {
    if (node.membership.view.epoch === 0 && node.membership.gate(node).open) {
      if (this.pending.size) this.#drain(node) // older parked attempts keep issue order ahead of this batch
      node.commit(recs)
      return
    }
    const me = this.issuer(node)
    for (const rec of recs)
      this.#enqueue(node, { cid: ++this.#cid, ae: node.epoch, issuer: me, rec, via: -1, sent: -1, to: '', parked: false })
    this.#drain(node)
  }

  //! flush — the flush boundary (gate transitions, view installs, admits — membership.settle calls this):
  // parked attempts re-enter the world with a REFRESHED attemptEpoch (#drain stamps it; lawful — this
  // node is the issuer or the owning relay of everything in its queue).
  flush(node: Node) { this.#drain(node) }

  //! tick — the retry clock (heartbeat): an in-flight attempt whose ACK/NACK never arrived re-parks after
  // RETRY_TICKS and the drain re-resolves + re-forwards it. Covers lost WRITE, lost ACK, a dead owner
  // (the view eventually evicts it; the re-resolve then targets the new owner) — and paces NACK retries
  // (onNack re-parks onto THIS clock, never straight back onto the wire). Dedup absorbs every duplicate.
  tick(node: Node) {
    if (this.pending.size === 0) return
    for (const a of this.pending.values())
      if (a.sent >= 0 && ++a.sent >= RETRY_TICKS) { a.sent = -1; this.#queued++ }
    this.#drain(node)
  }

  //! #enqueue — into the ONE bounded queue; overflow drops the OLDEST attempt (surfaced counter + journal).
  // A same-key re-enqueue (a client retransmitting a still-pending attempt) REPLACES the entry (idempotent).
  #enqueue(node: Node, a: Attempt) {
    const key = a.issuer + '|' + a.cid
    const old = this.pending.get(key)
    if (old && old.sent < 0) this.#queued--
    this.pending.set(key, a)
    this.#queued++
    if (this.pending.size > MAX_PENDING) {
      const oldest = this.pending.keys().next().value!
      const dropped = this.pending.get(oldest)!
      this.pending.delete(oldest)
      if (dropped.sent < 0) this.#queued--
      this.droppedPending++
      node.journal.armed && node.journal.emit(JK.writeBufferDrop, this.droppedPending)
    }
  }

  //! #drain — the ONE mover: walk parked attempts in issue order; commit the self-owned ones (this is
  // the flush-boundary re-validation: ownership is re-resolved against the CURRENT ring, so a write
  // parked before an ownership move forwards to the new owner instead of stamping locally — AA #3's
  // fix), forward the rest to their owners. A closed gate parks everything: minority/evicted/stale/
  // rejoining nodes move nothing until settle reopens (M2's CP semantics, kept — and while stale or
  // rejoining the local ring is untrustworthy anyway).
  #drain(node: Node) {
    if (this.#queued === 0) return
    const j = node.journal
    if (!node.membership.gate(node).open) {
      for (const a of this.pending.values())
        if (!a.parked && a.sent < 0) { a.parked = true; j.armed && j.emit(JK.writeBuffered, this.pending.size) }
      return
    }
    const epoch = node.membership.view.epoch
    if (this.ring.epoch !== epoch) this.ring.build(epoch, node.membership.view.members)
    let commits: Attempt[] | null = null
    let runs: Map<Link, Attempt[]> | null = null
    for (const a of this.pending.values()) {
      if (a.sent >= 0) continue
      const owner = epoch === 0 ? node.uuid : this.ring.ownerOf(partitionOf(a.rec))
      if (owner === node.uuid || owner === '') {
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
  #commit(node: Node, list: Attempt[]) {
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
        this.#remember(node, x.issuer, x.cid, s0 + k, node.epoch)
        this.#remove(x)
      }
      this.#ack(node, a.via, { u: a.issuer, c: a.cid, n: run.length, s: s0, e: node.epoch })
      i = jEnd
    }
  }

  //! #remove — drop an attempt from the queue with counter bookkeeping (no-op for never-queued attempts).
  #remove(a: Attempt) {
    if (this.pending.delete(a.issuer + '|' + a.cid) && a.sent < 0) this.#queued--
  }

  //! #remember — record a committed cid in the issuer's exact dedup window (oldest-first eviction), with
  // the lane count itself bounded: the oldest LANE evicts (journal-surfaced) past MAX_ISSUERS.
  #remember(node: Node, issuer: string, cid: number, s: number, e: number) {
    let lane = this.#seen.get(issuer)
    if (!lane) {
      lane = new Map()
      this.#seen.set(issuer, lane)
      if (this.#seen.size > MAX_ISSUERS) {
        const oldest = this.#seen.keys().next().value!
        this.#seen.delete(oldest)
        node.journal.armed && node.journal.emit(JK.dedupEvict, oldest)
      }
    }
    lane.set(cid, { s, e })
    if (lane.size > DEDUP_KEEP) lane.delete(lane.keys().next().value!)
  }

  //! #ack — WACK on the reply route (`via` link) for relayed/forwarded attempts; via -1 = locally issued, no frame.
  #ack(node: Node, via: number, v: { u: string; c: number; n: number; s: number; e: number }) {
    if (via < 0) return
    const link = node.links.get(via)
    if (!link || link.dead) return // the asker is gone; its retransmit will hit the dedup window instead
    link.ship(encodeControl(VERB.WACK, v), node.env.sink, node.journal)
  }

  //! onWrite — source=forwarded (and the client relay rule): a WRITE frame's provenance triple is the
  // attempt triple [issuer, baseCid, attemptEpoch]. ae 0 marks a CLIENT attempt: this server becomes the
  // relay — stamps ae (relay time is an issuer boundary), queues with the reply route, and owns
  // re-resolution from here. ae > 0 is an owner-validation ingress: dedup → validate → commit or WNACK.
  onWrite(node: Node, link: Link, f: Frame) {
    const j = node.journal
    const prov = f.prov()
    if (!prov) { j.armed && j.emit(JK.frameDrop, link.id, 'write without attempt triple'); return }
    const { origin: issuer, baseSeq: c0, epoch: ae } = prov
    if (ae === 0) {
      j.armed && j.emit(JK.writeRelay, issuer, c0)
      let i = 0
      for (const rv of f.records())
        this.#enqueue(node, { cid: c0 + i++, ae: node.epoch, issuer, rec: rv.rec(), via: link.id, sent: -1, to: '', parked: false })
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
    let commits: Attempt[] | null = null
    let nack: { r: string; c: number; n: number } | null = null
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
  onAck(node: Node, link: Link, v: { u?: unknown; c?: unknown; n?: unknown; s?: unknown; e?: unknown }) {
    if (typeof v?.u !== 'string' || typeof v.c !== 'number' || typeof v.n !== 'number' || v.n <= 0 || v.n > MAX_PENDING) return
    if (typeof v.s !== 'number' || typeof v.e !== 'number') return // coordinates hop onward to relays — garbage must not
    const j = node.journal
    j.armed && j.emit(JK.writeAck, v.u, v.c, v.n)
    let hop: { via: number; c: number; n: number; s: number } | null = null
    const flushHop = () => {
      if (!hop) return
      this.#ack(node, hop.via, { u: v.u as string, c: hop.c, n: hop.n, s: hop.s, e: v.e as number })
      hop = null
    }
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
    }
    flushHop()
  }

  //! onNack — typed rejection FROM THE OWNER OF RECORD: journal it, absorb the staleness evidence (ce),
  // and re-drive — onto the TICK CLOCK for same-epoch reasons (withheld/not-owner: re-forwarding
  // instantly just re-manufactures the same answer at line rate — the review's storm), or parked for
  // the next flush boundary when ce reveals a newer view (the install is the fresh routing state that
  // makes an immediate retry meaningful). The relay owns re-resolution for client attempts identically.
  onNack(node: Node, link: Link, v: { u?: unknown; c?: unknown; n?: unknown; r?: unknown; ce?: unknown }) {
    if (typeof v?.u !== 'string' || typeof v.c !== 'number' || typeof v.n !== 'number' || v.n <= 0 || v.n > MAX_PENDING) return
    const j = node.journal
    j.armed && j.emit(JK.writeNack, typeof v.r === 'string' ? v.r : '?', typeof v.ce === 'number' ? v.ce : -1, v.c)
    const newer = typeof v.ce === 'number' && v.ce > node.epoch
    if (newer) node.membership.staleObserved(node, v.ce as number, link)
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
  // Returns true when the record was FRESH (logged) — the caller WALs the frame iff anything was.
  inbound(node: Node, origin: string, seq: number, epoch: number, rv: { rec(): Rec; issuer: string; cid: number }): boolean {
    const j = node.journal
    //! the Lamport merge-up runs first, even for drops: the clock must track everything observed —
    // a reborn clock re-issuing a lost stamp would corrupt provenance cluster-wide.
    if (seq > node.seq) node.seq = seq
    //! NO own-lane special case since M4a: the stamp site advances the own applied watermark, so the
    // general dedup below already drops under-tail echoes of the CURRENT lane (the seed-79 poisoning).
    // A PREVIOUS life's lane (uuid vs uuid~inc) is an ordinary foreign stream here — immutable,
    // tail-complete at peers, healed by suffix AE like anything else (the M4b recovery story).
    const d = node.streams.for(origin)
    //! the APPLIED watermark advances at the dedup decision (LWW losers included — losing is not loss)
    if (seq <= d.applied) { j.armed && j.emit(JK.dupDrop, origin, seq); return false }
    d.applied = seq
    const rec = rv.rec() // ONE copy out of the receive chunk, shared by the log entry and the apply
    const entry: { rec: Rec; seq: number; epoch: number; iss?: string; cid?: number } = { rec, seq, epoch }
    if (rv.issuer) { entry.iss = rv.issuer; entry.cid = rv.cid }
    node.logFor(origin).push(entry)
    //! the SHIPPABLE watermark advances at the log append — the sole evidence confirm:'replicated'
    // may ever read (M4c); synchronous with applied today, a distinct site by design
    d.shippable = seq
    node.apply(rec, origin, seq, epoch)
    j.armed && j.emit(JK.applyInbound, origin, seq)
    if (rv.issuer) {
      this.#remember(node, rv.issuer, rv.cid, seq, epoch)
      const a = this.pending.get(rv.issuer + '|' + rv.cid)
      if (a) {
        //! replication IS an ACK: the commit is visible with its coordinates — clear the route
        j.armed && j.emit(JK.writeAck, rv.issuer, rv.cid, 1)
        if (a.via >= 0) this.#ack(node, a.via, { u: rv.issuer, c: rv.cid, n: 1, s: seq, e: epoch })
        this.#remove(a)
      }
    }
    return true
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
  replay(node: Node, f: Frame, prev: number) {
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
      if (rv.seq <= d.applied) continue // duplicate WAL rows (a re-persisted partially-fresh frame) re-dedup
      d.applied = rv.seq
      const rec = rv.rec()
      const entry: { rec: Rec; seq: number; epoch: number; iss?: string; cid?: number } = { rec, seq: rv.seq, epoch: rv.epoch }
      if (rv.issuer) { entry.iss = rv.issuer; entry.cid = rv.cid }
      node.logFor(prov.origin).push(entry)
      d.shippable = rv.seq
      d.durable = rv.seq
      node.apply(rec, prov.origin, rv.seq, rv.epoch)
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
