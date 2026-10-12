//! ── kernel/link — one identified logical link per peer pair ──────────────────
// v2's costliest transport lesson (DECISIONS T/T2/T3/T4, the failed socket-dedup
// pass): connections became usable BEFORE identity was established, and every
// server pair held two directional sockets — spawning shadows, #published
// WeakSets, idempotent-identify guards, and a dialer-gated catch-up trap that
// made the clean fix unretrofittable. v3 inverts both choices at birth
// (plan §4 structural delta 1):
//
//   - identity-before-admission: a link routes NOTHING until the HELLO exchange
//     resolves {uuid, incarnation}; membership/gossip/records all wait.
//   - exactly ONE logical link per pair: on identify, the deterministic keeper
//     is the link dialed by the lower uuid — both ends evaluate the same rule on
//     the same link, so no coordination frame is needed and a simultaneous
//     dial-race collapses to one survivor on both sides.
//
// The link also owns the send plane for its peer: a streaming Outbox (records
// appended during a step, one frame flushed per step — v2's microtask
// coalescing, made deterministic; a run bigger than the node's frame cap leaves
// in several frames, V4-51) and a BOUNDED paused-queue with drop-oldest +
// a journal loss event (plan §3.4: every buffer bounded at birth, every loss
// journal-visible). Backpressure states: flowing → paused (env said the socket
// buffer filled) → flowing on drain.

import { Framer, Outbox, VERB, MAX_FRAME,                            } from './codec.js'
import { JK,              } from './journal.js'
                                          
                                          

//! MAX_QUEUED: frames a paused link may hold before drop-oldest kicks in. M0 policy — M1 replaces the drop with spill-to-log (the log IS the retransmit buffer).
// The default of the tune row `queued` (kernel/tune.ts): a Link has no node, so the node hands its row in at construction (Link.maxQueued).
export const MAX_QUEUED = 256

//! LinkState: the admission ladder. M0 collapses identified→admitted (no membership yet); the distinct states exist so M2 can insert a view-admission step without reshaping the machine.
//! LS.diag (M7): the authenticated diagnostics latch — a state, not a field. An LS.diag link is
// structurally outside membership: never in byUuid/clientLinks, never counted by admitted(), and every
// admitted-only verb closes it (kernel/diag.ts holds the whole machine). Appended, never renumbered.
//! LS.proving (DESIGN-DOOR §3): the link has read a HELLO that carries `k` and waits for the proof — the
// peer's HELLO is stashed on the Link, and the link is NOT in byUuid, NOT in clientLinks, NOT counted by
// admitted(); every admitted-only verb closes it, so it can carry nothing but DOOR. Only a node WITH a
// door ever puts a link here.
export const LS = { hello: 0, admitted: 1, diag: 2, proving: 3 }         

export class Link {
  state         = LS.hello
  //! peer identity — set exactly once, by the HELLO exchange
  uuid = ''
  incarnation = 0
  listen = ''
  //! wire machinery — one framer (inbound re-slicing) + one streaming outbox (outbound coalescing) per link, reused forever.
  // The outbox cuts at the node's tune row `frame`, handed in at construction (MAX_FRAME unless a test asks less)
  framer = new Framer()
  outbox        
  //! backpressure — paused mirrors the env's socket-buffer state; queued holds finished frames while paused (bounded)
  paused = false
  queued               = []
  //! synced: live records flow on this link ONLY after the peer's digest has been received. The seed sweeps
  // proved why (24% of seeds diverged without it): a live frame sent between admit and the digest-triggered
  // suffix ship LEAPFROGS the suffix on the wire; the receiver's monotone high-water then discards the older
  // suffix as duplicates — an interior gap no suffix digest can ever heal. Unsynced links withhold live
  // records; the suffix shipped when the digest arrives covers them (it is computed from the log tails), and
  // everything after flows monotone. The same flag closes the backpressure hole: an overflow de-syncs the
  // link until the drain-time digest exchange completes.
  synced = false
  //! set when overflow cleared the queue: the peer now has a TAIL hole, and the drain handler follows up
  // with a digest exchange to re-ship it (loss heals, never lingers)
  droppedWhilePaused = false
  //! torn (the third re-check of DESIGN-SCALE stage 2, 2026-10-10; reshaped 2026-10-11): a digest ANSWER whose
  // suffix ship stopped because this link was paused and its queue full (or whose queued frames a clear took since).
  // `d` is the cover: the peer's tails, raised to what that answer had already handed the link before the first frame
  // it did not; `r` and `q` are its digest's. The node resumes the answer from there at the drain (node.ts #answer —
  // an answer with the cover as its tails ships exactly the rest), so the reply always follows the whole ship. Null
  // when no answer is torn. Set only on a link that ships suffixes (an unscoped member's, a client's); an armed member
  // link gets no suffix and never tears. A clear on a CLIENT link sets or lowers it too (wave 5f, onClear below). A
  // cover the clear SETS (no answer was owed: `r` and `q` undefined) is a ceiling, marked `c`: the drain does not resume
  // it; the peer's next digest (its reply to the drain digest) is answered from the lower of its tails and the ceiling,
  // lane by lane (node.ts #clearCover), so the tap-forwards the clear took are re-sent and nothing else is assumed.
  torn                                                                                               = null
  //! inQueue: the same shape, for the answer whose frames (or reply) sit in the queue right now — the cover at its
  // FIRST queued frame. It is what keeps an answer resumable until its reply has left the queue: a clear (ship below)
  // makes it the torn answer, so the drain re-sends what the clear took and the reply, never the whole ship again.
  // The drain's flush empties it. Null when no answer has a frame queued.
  inQueue                                                                                     = null
  //! onClear (wave 5f): set on a CLIENT link only (node.ts at admit), and called by a clear (ship below) with the frames
  // it took. A synced client link is fed by tap-forward, and a tap-forward can carry a record SPLICED into a lane's
  // interior, below the spoke's tails; a clear also leaves the frames shipped after it in the same flush, which then
  // leapfrog what it took. The drain digest answers above the spoke's tails, so it heals neither. The node turns what
  // the clear took into `torn` (node.ts #clearCover), and the next answer to this link re-sends it. `wasSynced` is the link's synced flag
  // from just before this clear: a clear on a synced link leaves a cover even when it took no record frame, because
  // from then on the link is unsynced and nothing is tapped to it. Null on every other link: a member link's clear is
  // unchanged.
  onClear                                                                           = null
  //! quiet — heartbeats since this link last carried a byte in (node.ts bytesIn resets it). Read only by a node
  // with watchClients (the #directory host's failure detector over client links); on every other node it stays 0.
  quiet = 0
  dead = false // set on wire fault so a half-processed chunk can't keep dispatching before linkDown arrives
  //! noRedial: set before a DELIBERATE close (dup-link, self-reject) — without it, closing the loser of a dial race would redial and re-create the race forever
  noRedial = false
  //! client (M5b): the peer identified as a CLIENT (HELLO r:1) — a spoke, never a view member: excluded
  // from genesis sweeps, fed by tap-forward when synced (it digests exactly ONE server, its primary, so
  // synced here means "this node is that primary" — the single-feeder ordering guarantee)
  client = false
  //! methodsOnly (DESIGN-DOOR §4): the peer's HELLO carried `m: 1` — it is a server that takes client
  // changes only through its methods. Set at admit; a CLIENT reads it live off its primary
  // (node.feederMethodsOnly) to refuse its own plain writes without the round trip.
  methodsOnly = false
  //! contract (DESIGN-DOOR §4, DESIGN-SCALE stage 1): the peer's HELLO `c` as it came, kept at admit. A
  // member checks it at the door and is done; a CLIENT reads it live off its primary (node.feederContract)
  // to learn whether its feeder is scoped — a scoped feeder shows the spoke only the partitions it holds,
  // so an absent row there says nothing about the resource. Undefined from a client, the sim, an old server.
  contract         
  //! the door (DESIGN-DOOR §3, secured nodes only — every field stays at its zero on the open path):
  // nonce = MY `k` for this link, minted by door.nonce() at linkUp and never reused; said = the HELLO I
  // sent, the exact object (my proof signs its keys); hello = the peer's HELLO, stashed while proving
  // and cleared at admit; proved = I shipped my DOOR {p} (only then can a DOOR {e} refuse me; a bare
  // close while proving is a link loss, never a refusal);
  // proveTimer = the one-shot TAG.prove timer's id, -1 when none.
  nonce = ''
  said                   = null
  hello                   = null
  proved = false
  proveTimer = -1

  id        
  dialed         
  to         
  //! maxQueued — the paused-queue bound, the node's tune row `queued` handed in at construction (a Link has no node);
  // `frame` likewise — the most body bytes one of this link's frames may hold
  maxQueued        
  constructor(id        , dialed         , to         , maxQueued = MAX_QUEUED, frame = MAX_FRAME) {
    this.id = id; this.dialed = dialed; this.to = to; this.maxQueued = maxQueued
    this.outbox = new Outbox(frame)
  }

  //! addRecord: append to the step's RECORDS frame, opening it with this run's provenance (and, for
  // committed attempt runs, its attempt identity) on first use. Run continuity is CHECKED, not
  // assumed (M6-review): the armed fan-out filter hands each link a lawfully-GAPPY subset of a
  // commit batch, and a frame's seqs/cids decode as baseSeq+i/baseCid+i — a discontinuous add
  // ROTATES the open frame into the outbox's pending list and begins fresh. Unscoped fan-out is
  // every-record-every-link, so rotation never fires there (byte-identity preserved). A run that
  // passes the frame cap is CUT the same way (V4-51, Outbox.add): the next frame continues the run.
  // `pp` is the record's sub-stream predecessor (armed senders only — undefined keeps FLAG_PP off the frame).
  add(rec                              , prov      , attempt             , pp         ) {
    if (this.outbox.open && (!this.outbox.continues(prov, attempt) || this.outbox.pp !== (pp !== undefined)))
      this.outbox.rotate()
    if (!this.outbox.open) this.outbox.begin(VERB.RECORDS, prov, attempt, pp !== undefined)
    this.outbox.add(rec, pp)
  }

  //! flush: close the step's frame(s) and ship — rotated and cut frames first (order kept), then the open
  // one — or park them (bounded) if the socket is backed up.
  //! A flush that CLEARS the queue ships nothing more (V4-51): what is left of it is part of the lost tail. A frame
  // queued after a clear sits ABOVE the hole: delivered at the drain, it moves the receiver's scalar fence past the
  // lost records, and the drain digest — which re-ships only above the receiver's tails — never sends them again (an
  // unscoped member ended with 4 of 10 rows for good, the design's probe E). One frame per flush made that rare;
  // cut frames make several common. Later steps add nothing to the now-unsynced link until the heal. A CLIENT link
  // (onClear set, wave 5f) ships on as before: the clear's cover lowers every lane it took, so the answer to the
  // spoke's reply re-sends what a surviving frame leapfrogged.
  flush(sink            , j         ) {
    let live = true
    if (this.outbox.pending.length) {
      for (const bytes of this.outbox.pending) if (live) live = this.ship(bytes, sink, j) || this.onClear !== null
      this.outbox.pending.length = 0
    }
    const bytes = this.outbox.finish()
    if (bytes !== null && live) this.ship(bytes, sink, j)
  }

  //! ship: the ONE send gate — flowing → sink.send; paused → bounded queue. Overflow drops the WHOLE queue,
  // not the oldest entry: partial drops manufacture interior gaps (survivors leapfrog the hole at drain time,
  // ahead of any heal), while a full clear keeps the loss a pure TAIL — exactly what the digest exchange the
  // drain handler triggers knows how to re-ship. De-syncing here stops any further records widening the hole.
  // A caller that ships a WHOLE suffix in one step (node.ts #answer) never overflows on purpose: the shell steps
  // `pause` inside a send, so it checks for a full queue before every frame and stops there. A digest answer whose
  // frames this clear takes becomes the torn answer (`inQueue` → `torn`), resumed at the drain. On a client link the
  // clear also hands what it took to `onClear`, so a tap-forward it took is re-sent too (wave 5f).
  //! Returns false when the frame is lost — the link is dead, or THIS ship cleared the queue (it went with the
  // clear) — so a caller shipping several frames stops there (flush above).
  ship(bytes            , sink            , j         )          {
    if (this.dead) return false
    if (!this.paused) { sink.send(this.id, bytes); return true }
    this.queued.push(bytes)
    if (this.queued.length > this.maxQueued) {
      j.armed && j.emit(JK.dropOldest, this.id, this.queued.length)
      const dropped = this.onClear !== null ? this.queued : null
      if (dropped !== null) this.queued = []
      else this.queued.length = 0
      const wasSynced = this.synced
      this.droppedWhilePaused = true
      this.synced = false
      if (this.inQueue !== null) { this.torn = this.inQueue; this.inQueue = null }
      if (dropped !== null) this.onClear (this, dropped, wasSynced)
      return false
    }
    return true
  }

  //! drain: the env's socket buffer emptied — release the parked frames in order.
  drain(sink            , j         ) {
    this.paused = false
    j.armed && j.emit(JK.drain, this.id)
    for (const bytes of this.queued) sink.send(this.id, bytes)
    this.queued.length = 0
    this.inQueue = null // every queued frame has left: an answer is past the reach of a clear once its reply is out
  }
}

//! keeper rule: KEEP the link dialed by the LOWER uuid — a pure function of (myUuid, theirUuid, whoDialedThisLink), so both ends pick the same survivor with zero coordination.
export const dialedByLower = (link      , me        , them        )          =>
  link.dialed ? me < them : them < me
