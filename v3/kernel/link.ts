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
// coalescing, made deterministic) and a BOUNDED paused-queue with drop-oldest +
// a journal loss event (plan §3.4: every buffer bounded at birth, every loss
// journal-visible). Backpressure states: flowing → paused (env said the socket
// buffer filled) → flowing on drain.

import { Framer, Outbox, VERB, type AttemptRun, type Prov } from './codec.ts'
import { JK, type Journal } from './journal.ts'
import type { EffectSink } from './env.ts'

//! MAX_QUEUED: frames a paused link may hold before drop-oldest kicks in. M0 policy — M1 replaces the drop with spill-to-log (the log IS the retransmit buffer).
export const MAX_QUEUED = 256

//! LinkState: the admission ladder. M0 collapses identified→admitted (no membership yet); the distinct states exist so M2 can insert a view-admission step without reshaping the machine.
export const LS = { hello: 0, admitted: 1 } as const

export class Link {
  state: number = LS.hello
  //! peer identity — set exactly once, by the HELLO exchange
  uuid = ''
  incarnation = 0
  listen = ''
  //! wire machinery — one framer (inbound re-slicing) + one streaming outbox (outbound coalescing) per link, reused forever
  framer = new Framer()
  outbox = new Outbox()
  //! backpressure — paused mirrors the env's socket-buffer state; queued holds finished frames while paused (bounded)
  paused = false
  queued: Uint8Array[] = []
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
  dead = false // set on wire fault so a half-processed chunk can't keep dispatching before linkDown arrives
  //! noRedial: set before a DELIBERATE close (dup-link, self-reject) — without it, closing the loser of a dial race would redial and re-create the race forever
  noRedial = false
  //! client (M5b): the peer identified as a CLIENT (HELLO r:1) — a spoke, never a view member: excluded
  // from genesis sweeps, fed by tap-forward when synced (it digests exactly ONE server, its primary, so
  // synced here means "this node is that primary" — the single-feeder ordering guarantee)
  client = false

  id: number
  dialed: boolean
  to?: string
  constructor(id: number, dialed: boolean, to?: string) { this.id = id; this.dialed = dialed; this.to = to }

  //! addRecord: append to the step's RECORDS frame, opening it with this run's provenance (and, for
  // committed attempt runs, its attempt identity) on first use. Callers guarantee run continuity: one
  // commit batch = one contiguous (seq, cid) run, flushed before the next batch opens.
  add(rec: Parameters<Outbox['add']>[0], prov: Prov, attempt?: AttemptRun) {
    if (!this.outbox.open) this.outbox.begin(VERB.RECORDS, prov, attempt)
    this.outbox.add(rec)
  }

  //! flush: close the step's frame and ship it — or park it (bounded) if the socket is backed up.
  flush(sink: EffectSink, j: Journal) {
    const bytes = this.outbox.finish()
    if (!bytes) return
    this.ship(bytes, sink, j)
  }

  //! ship: the ONE send gate — flowing → sink.send; paused → bounded queue. Overflow drops the WHOLE queue,
  // not the oldest entry: partial drops manufacture interior gaps (survivors leapfrog the hole at drain time,
  // ahead of any heal), while a full clear keeps the loss a pure TAIL — exactly what the digest exchange the
  // drain handler triggers knows how to re-ship. De-syncing here stops any further records widening the hole.
  ship(bytes: Uint8Array, sink: EffectSink, j: Journal) {
    if (this.dead) return
    if (!this.paused) return sink.send(this.id, bytes)
    this.queued.push(bytes)
    if (this.queued.length > MAX_QUEUED) {
      j.armed && j.emit(JK.dropOldest, this.id, this.queued.length)
      this.queued.length = 0
      this.droppedWhilePaused = true
      this.synced = false
    }
  }

  //! drain: the env's socket buffer emptied — release the parked frames in order.
  drain(sink: EffectSink, j: Journal) {
    this.paused = false
    j.armed && j.emit(JK.drain, this.id)
    for (const bytes of this.queued) sink.send(this.id, bytes)
    this.queued.length = 0
  }
}

//! keeper rule: KEEP the link dialed by the LOWER uuid — a pure function of (myUuid, theirUuid, whoDialedThisLink), so both ends pick the same survivor with zero coordination.
export const dialedByLower = (link: Link, me: string, them: string): boolean =>
  link.dialed ? me < them : them < me
