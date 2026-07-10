//! ── kernel/streams — per-origin StreamDescriptor: the three watermarks as FIELDS ──
// M4a (plan §4 module table + §5 watermarks). v2 tracked stream state in four
// parallel string-keyed maps (seen/marks/persisted/versions) that drifted
// independently — one consumer (recvReplProbe) answered confirm:'replicated'
// off the WRONG one, a documented guaranteed-false-positive. v3 gives each
// stream ONE descriptor object whose fields are the ladder:
//
//   applied   — the dedup watermark: highest applied-or-skipped seq. Advances
//               at the dedup decision (LWW losers included — losing an election
//               is not loss). Feeds AE digests ONLY; never evidence for confirm.
//   shippable — logged: the record is in the per-origin log (the retransmit
//               buffer). The SOLE evidence for confirm:'replicated' and shed
//               confirmation (M4c/M6).
//   durable   — a storage batch covering this seq has RESOLVED (M4b's WAL).
//               The SOLE evidence for confirm:'persisted'. Stays 0 until the
//               storage seam lands; the field and its monitor exist from M4a so
//               the ordering contract is enforced before anything can violate it.
//
// The contract (plan §5, verbatim): applied ≥ shippable ≥ durable, asserted per
// event in sim (the watermark-ordering monitor). In today's kernel applied and
// shippable advance in the same synchronous step (every arrival is logged, then
// applied) — the fields exist SEPARATELY because M4b makes durable lag on fsync
// and M4d's segment log gives shippable its own advance site; the false-positive
// class dies by making the wrong-field read unwritable, not by care.
//
// Keyed per-origin (R=∞): every node holds every stream. The plan's full
// per-(origin, partition) keying is M6's — scoped replication needs per-partition
// watermarks for R-set shedding; introducing that dimension now would fragment
// the dedup high-water for no consumer (and rung 1 of the de-scoping ladder
// defers exactly that feature). Recorded in CHECKPOINT.md.

//! StreamDescriptor: one stream's ladder — plain fields, allocation-light, one object per origin.
export class StreamDescriptor {
  applied = 0
  shippable = 0
  durable = 0
}

//! Streams: the per-origin descriptor table (get-or-create on the hot path, iterable for monitors/capture).
export class Streams {
  #m = new Map<string, StreamDescriptor>()
  //! for — get-or-create: the ingest path's single lookup per record run.
  for(origin: string): StreamDescriptor {
    let d = this.#m.get(origin)
    if (!d) { d = new StreamDescriptor(); this.#m.set(origin, d) }
    return d
  }
  get(origin: string): StreamDescriptor | undefined { return this.#m.get(origin) }
  get size(): number { return this.#m.size }
  [Symbol.iterator](): IterableIterator<[string, StreamDescriptor]> { return this.#m[Symbol.iterator]() }
}
