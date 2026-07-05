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
} as const

//! JEvent: one journal row. `t` is a per-node monotone counter (NOT wall time — deterministic under sim).
export interface JEvent { t: number; kind: number; a?: number | string; b?: number | string; c?: number | string }

//! Journal: bounded drop-oldest ring + monotone counter + surfaced drop count.
export class Journal {
  #ring: (JEvent | undefined)[]
  #cap: number
  n = 0            // total events ever emitted — ring holds the last min(n, cap)
  dropped = 0      // events lost to overflow — surfaced, never silent
  armed = true
  constructor(cap: number = 4096) { this.#cap = cap; this.#ring = new Array(cap) }
  emit(kind: number, a?: number | string, b?: number | string, c?: number | string) {
    const t = this.n++
    if (t >= this.#cap) this.dropped++
    this.#ring[t % this.#cap] = { t, kind, a, b, c }
  }
  //! read(from): all retained events with t >= from, in order — cursor-style consumption (relay/fold read by cursor, never by draining a shared array: v2's 10%-temporal-coverage bug class).
  read(from = 0): JEvent[] {
    const lo = Math.max(from, this.n - this.#cap)
    const out: JEvent[] = []
    for (let t = lo; t < this.n; t++) out.push(this.#ring[t % this.#cap]!)
    return out
  }
}
