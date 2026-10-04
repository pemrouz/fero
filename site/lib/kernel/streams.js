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
// Keyed per-origin, with the M6 partition dimension as an OVERLAY: the scalar
// ladder stays the dedup/digest fast path on every node, and scoped nodes
// (node.armed) additionally carry per-(origin, partition) POSSESSION FLOORS —
// `parts` below — allocated only when armed, so R=∞ descriptors are shape-
// identical with M4. The per-origin `applied` dedup fence NEVER fragments
// (DESIGN-M6 §0: splitting it per-partition breaks gap-tolerant dedup); the
// partition dimension applies to possession evidence, not the fence.

//! StreamDescriptor: one stream's ladder — plain fields, allocation-light, one object per origin.
export class StreamDescriptor {
  applied = 0
  shippable = 0
  durable = 0
  //! parts (M6, DESIGN-M6 §0): partition → {s, d} possession floors, armed nodes only. `s` attests
  // "my log CONTAINS-OR-COVERS every (origin, p) record with seq ≤ s" — a floor, not a max-in-log
  // (compaction may have dropped covered losers). It is the SOLE scoped possession claim: HAVEA
  // answers, shed evidence, scoped confirm counting, and the scoped frontier all read it. `d` is its
  // durable counterpart, advanced only by echoes whose rows the disk can actually restore (the
  // no-interior-rows WAL discipline — a splice reaches disk via snapshot(), never persistRun).
  parts                                        

  //! part — get-or-create a partition's floor entry (armed ingest/stamp/replay sites only).
  part(p        )                           {
    let m = this.parts
    if (!m) { m = new Map(); this.parts = m }
    let e = m.get(p)
    if (!e) { e = { s: 0, d: 0 }; m.set(p, e) }
    return e
  }
}

//! Streams: the per-origin descriptor table (get-or-create on the hot path, iterable for monitors/capture).
export class Streams {
  #m = new Map                          ()
  //! for — get-or-create: the ingest path's single lookup per record run.
  for(origin        )                   {
    let d = this.#m.get(origin)
    if (!d) { d = new StreamDescriptor(); this.#m.set(origin, d) }
    return d
  }
  get(origin        )                               { return this.#m.get(origin) }
  get size()         { return this.#m.size }
  [Symbol.iterator]()                                               { return this.#m[Symbol.iterator]() }
}
