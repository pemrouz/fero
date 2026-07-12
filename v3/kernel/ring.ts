//! ── kernel/ring — vnode consistent-hash ownership: ONE owner per partition per epoch ──
// M3 (plan §4 module table). The ring is a PURE FUNCTION of a committed view:
// every node that has installed view e builds byte-identical arrays and answers
// ownerOf() identically — which, combined with the one-view-per-epoch monitor,
// is what makes "exactly one origin stamps a partition at epoch e" a structural
// property instead of a coordination protocol. Nothing here is gossiped: there
// is no ring state to diverge, only the view (whose agreement M2 already pays for).
//
// Shape (plan, verbatim): vnode hashring as TWO PARALLEL SORTED ARRAYS —
// Uint32Array hash points + Uint16Array member indices — so ownerOf() is one
// string hash + one binary search + two typed-array reads + one interned-string
// return: ALLOCATION-FREE on the lookup path (the write pipeline consults it on
// every issued record). Rebuilds are per view install (cold): sort cost is paid
// once per epoch, never per write.
//
// The hash is INJECTABLE (constructor arg) because the sim's determinism story
// requires the ring be a function of inputs only — and because tests must be
// able to model hash migration without editing the kernel. The PLACEMENT
// OVERRIDE (place()) exists for tests that need a named partition on a named
// node (the AA fault schedules pin ownership so a scenario reads as intent, not
// as reverse-engineered hash collisions). Both are test seams; production uses
// the default fnv-1a and an empty override map.

//! VNODES: hash points per member — enough to keep ownership spread within ~2x of fair at small
// cluster sizes without making rebuilds or the arrays noticeable (128 members = 4096 points = 24KB).
export const VNODES = 32

//! fnv — fnv-1a over a string (same primitive the state hash uses); >>> 0 for the u32 point space.
const fnv = (s: string): number => {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) }
  return h >>> 0
}

export class Ring {
  //! epoch this ring was built from — the write pipeline rebuilds lazily when it trails the committed view
  epoch = -1
  #points = new Uint32Array(0)
  #owners = new Uint16Array(0)
  #members: string[] = []
  #hash: (s: string) => number
  #place = new Map<string, string[]>()
  //! holdersOf scratch — one reusable out-array + per-member seen flags, so the R-set lookup stays
  // allocation-free like ownerOf (the scoped fan-out consults it per committed record). The returned
  // array is INVALIDATED by the next holdersOf call on this ring — callers copy if they retain.
  #scratch: string[] = []
  #seen = new Uint8Array(0)
  //! holders memo — the per-epoch cache behind the hot callers (fan-out filter, AE answer filter,
  // holdsAny): one successor walk per touched partition per epoch, then one Map.get per record.
  // Cleared wholesale on build() (a new view is a new placement world) and per-partition on place().
  #holdersCache = new Map<string, { r: number; list: readonly string[] }>()

  constructor(hash: (s: string) => number = fnv) { this.#hash = hash }

  //! build — rebuild from a committed view's member uuids (sorted by uuid upstream; order only matters
  // for the deterministic tie-break). Cold path: one array of vnode entries, sorted, then split into
  // the two parallel typed arrays the hot lookup reads.
  build(epoch: number, members: [string, string][]) {
    this.epoch = epoch
    this.#members = members.map((m) => m[0])
    const n = this.#members.length * VNODES
    const entries: { p: number; m: number; v: number }[] = new Array(n)
    for (let m = 0, k = 0; m < this.#members.length; m++)
      for (let v = 0; v < VNODES; v++, k++) entries[k] = { p: this.#hash(this.#members[m] + '#' + v), m, v }
    //! full tie-break (point, member, vnode): equal hash points must order identically on every node —
    // an engine-dependent unstable sort here would be a silent split-brain generator
    entries.sort((a, b) => a.p - b.p || a.m - b.m || a.v - b.v)
    this.#points = new Uint32Array(n)
    this.#owners = new Uint16Array(n)
    for (let i = 0; i < n; i++) { this.#points[i] = entries[i].p; this.#owners[i] = entries[i].m }
    this.#seen = new Uint8Array(this.#members.length)
    this.#holdersCache.clear()
  }

  //! ownerOf — the allocation-free lookup: first vnode point ≥ hash(partition), wrapping to 0.
  // Returns '' on an empty ring (open genesis: every node owns its own writes).
  ownerOf(partition: string): string {
    const o = this.#place.get(partition)
    if (o !== undefined) return o[0]
    const points = this.#points
    if (points.length === 0) return ''
    const h = this.#hash(partition)
    let lo = 0, hi = points.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (points[mid] < h) lo = mid + 1
      else hi = mid
    }
    return this.#members[this.#owners[lo === points.length ? 0 : lo]]
  }

  //! holdersOf — the R-SET lookup (M6 scoped replication): the first r DISTINCT members on the
  // successor walk from hash(partition), holder[0] === ownerOf(partition) always (single-writer is
  // untouched — the owner is just the first holder). Same determinism story as ownerOf: a pure
  // function of the committed view, so every node that installed epoch e computes the identical
  // R-set. r is clamped to the member count (r ≥ members = full replication, the R=∞ degeneracy);
  // pinned partitions contribute their pin list first, then the walk fills the remainder with
  // distinct unpinned members. Returns the reusable scratch array — copy before retaining.
  holdersOf(partition: string, r: number): readonly string[] {
    const out = this.#scratch
    out.length = 0
    if (r <= 0) return out
    const members = this.#members
    const seen = this.#seen
    seen.fill(0)
    //! pins first, ownerOf semantics kept: a pinned uuid need not be a member (test seam contract)
    const pinned = this.#place.get(partition)
    if (pinned !== undefined)
      for (const u of pinned) {
        if (out.length >= r) return out
        if (!out.includes(u)) {
          out.push(u)
          const mi = members.indexOf(u)
          if (mi >= 0) seen[mi] = 1
        }
      }
    const points = this.#points
    if (points.length === 0) return out
    const h = this.#hash(partition)
    let lo = 0, hi = points.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (points[mid] < h) lo = mid + 1
      else hi = mid
    }
    if (lo === points.length) lo = 0
    //! successor walk: consecutive vnode points often repeat a member — the seen flags dedup; the
    // walk terminates after one full lap (every member has been offered) or r distinct collected
    for (let i = 0; i < points.length && out.length < r; i++) {
      const mi = this.#owners[(lo + i) % points.length]
      if (seen[mi] === 0) { seen[mi] = 1; out.push(members[mi]) }
    }
    return out
  }

  //! holders — the MEMOIZED R-set (the hot entry point): the frozen copy is stable until the next
  // build()/place(), so the fan-out filter and AE answer filter share one walk per partition per
  // epoch. r participates in the hit test (R_eff shifts when the view shrinks below replicas).
  holders(partition: string, r: number): readonly string[] {
    const hit = this.#holdersCache.get(partition)
    if (hit !== undefined && hit.r === r) return hit.list
    const list = Object.freeze([...this.holdersOf(partition, r)])
    this.#holdersCache.set(partition, { r, list })
    return list
  }

  //! holdsAny — R-set membership (the scoped counterpart of holds): is uuid one of the r holders?
  // Linear over ≤ r entries of the memoized list — allocation-free after the first walk.
  holdsAny(uuid: string, partition: string, r: number): boolean {
    return this.holders(partition, r).includes(uuid)
  }

  //! holds — does this uuid own the partition? (The name the plan reserves; same allocation-free path.)
  holds(uuid: string, partition: string): boolean { return this.ownerOf(partition) === uuid }

  //! place — TEST-ONLY placement override: pin a partition to a member (or, for scoped-replication
  // schedules, an ordered holder list — pins[0] is the owner) so fault schedules read as intent.
  // Must be applied identically on every node of a sim (the ring's determinism contract is the caller's
  // to keep when overriding). Never used in production paths.
  place(partition: string, ...uuids: string[]) {
    if (uuids.length === 0) this.#place.delete(partition) // unpin — back to the hash walk
    else this.#place.set(partition, uuids)
    this.#holdersCache.delete(partition)
  }
}
