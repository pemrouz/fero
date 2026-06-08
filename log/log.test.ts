import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Log, partitionOf, originKey, versionKey } from './log.ts'
import { view, value, applyRecord } from './index.ts'
import type { ChangeRecord } from '../transport/message.ts'

// order-insensitive deep compare (LWW converges on values, not key order — DECISIONS A)
const stable = (o: unknown): string =>
  JSON.stringify(o, (_k, v) =>
    v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([x], [y]) => (x < y ? -1 : 1))) : v,
  )
// the state a record list materializes (the proxy projection — what a peer ends up holding)
const stateOf = (records: ChangeRecord[]): unknown => {
  const log = new Log()
  for (const r of records) log.append(r)
  return view(log)[value]
}

test('append segments by partition (key[0]) and tracks per-partition heads', () => {
  const log = new Log()
  assert.equal(log.append({ type: 'update', key: ['user42'], value: { a: 1 } }), 1)
  assert.equal(log.append({ type: 'update', key: ['user42', 'active'], value: false }), 2) // same partition
  assert.equal(log.append({ type: 'update', key: ['user99'], value: { b: 2 } }), 1) // new partition
  assert.deepEqual(log.heads(), { user42: 2, user99: 1 })
  assert.equal(log.size, 3)
})

test('root insert is partitioned by `at` (the BI0 first-write case)', () => {
  const log = new Log()
  log.append({ type: 'insert', key: [], value: { name: 'P' }, at: 'user42' })
  assert.deepEqual(log.partitions(), ['user42'])
  assert.equal(partitionOf({ type: 'insert', key: [], at: 'user42' }), 'user42')
  assert.equal(partitionOf({ type: 'update', key: ['k', 'sub'] }), 'k')
})

test('onAppend observes appends; unsubscribe stops it', () => {
  const log = new Log()
  const seen: any[] = []
  const off = log.onAppend((record, p, offset) => seen.push([p, offset, record.type]))
  log.append({ type: 'update', key: ['a'], value: 1 })
  log.append({ type: 'remove', key: ['a'] })
  off()
  log.append({ type: 'update', key: ['a'], value: 2 })
  assert.deepEqual(seen, [
    ['a', 1, 'update'],
    ['a', 2, 'remove'],
  ])
})

test('since/diff give the catch-up tail (the sync primitives)', () => {
  const log = new Log()
  for (let i = 0; i < 5; i++) log.append({ type: 'update', key: ['p'], value: i })
  log.append({ type: 'update', key: ['q'], value: 'x' })

  assert.deepEqual(log.since('p', 3).map((r) => r.value), [3, 4])
  assert.equal(log.diff({ p: 5, q: 1 }).length, 0) // caller fully caught up
  assert.equal(log.diff({ p: 5 }).length, 1) // missing all of q
  assert.equal(log.diff({}).length, 6) // fresh join → everything
  assert.deepEqual(log.heads(), { p: 5, q: 1 })
})

test('recordsSince / marks (full mode): the per-origin anti-entropy primitives', () => {
  const log = new Log() // default: full replication → per-origin index
  // two origins; seqs strictly increasing per origin (Lamport — note A's gap 2→5)
  log.append({ type: 'update', key: ['x'], value: 1, origin: 'A', seq: 1 })
  log.append({ type: 'update', key: ['y'], value: 2, origin: 'A', seq: 2 })
  log.append({ type: 'update', key: ['z'], value: 3, origin: 'B', seq: 1 })
  log.append({ type: 'update', key: ['x'], value: 9, origin: 'A', seq: 5 }) // Lamport jump

  assert.deepEqual(log.marks(), { A: 5, B: 1 })

  // a peer that has A up to seq 2 and nothing from B gets A's seq-5 record + all of B
  assert.deepEqual(
    log.recordsSince({ A: 2 }).map((r) => [r.origin, r.seq]),
    [['A', 5], ['B', 1]],
  )
  // fully caught up → nothing
  assert.equal(log.recordsSince({ A: 5, B: 1 }).length, 0)
  // fresh peer (empty vector) → everything, grouped by origin in seq order
  assert.deepEqual(
    log.recordsSince({}).map((r) => [r.origin, r.seq]),
    [['A', 1], ['A', 2], ['A', 5], ['B', 1]],
  )
})

test('recordsSince / marks (scoped mode): per-(origin,partition) anti-entropy + rebalance', () => {
  const log = new Log({ scoped: true }) // finite R → per-(origin,partition) index
  // origin A writes partitions x and y; origin B writes z. Per (origin,partition)
  // each stream's seqs are strictly increasing — A's x-stream jumps 1→5.
  log.append({ type: 'update', key: ['x'], value: 1, origin: 'A', seq: 1 })
  log.append({ type: 'update', key: ['y'], value: 2, origin: 'A', seq: 2 })
  log.append({ type: 'update', key: ['z'], value: 3, origin: 'B', seq: 1 })
  log.append({ type: 'update', key: ['x'], value: 9, origin: 'A', seq: 5 })

  assert.deepEqual(log.marks(), {
    [originKey('A', 'x')]: 5,
    [originKey('A', 'y')]: 2,
    [originKey('B', 'z')]: 1,
  })

  // a peer with A.x up to seq 1 and nothing else gets A.x's seq-5 record + all of
  // A.y and B.z (never seen → from the start). Output sorted by (origin,seq) so an
  // origin's records coalesce into the fewest frames: A.y(seq2) before A.x(seq5).
  assert.deepEqual(
    log.recordsSince({ [originKey('A', 'x')]: 1 }).map((r) => [r.origin, partitionOf(r), r.seq]),
    [['A', 'y', 2], ['A', 'x', 5], ['B', 'z', 1]],
  )
  // fully caught up → nothing
  assert.equal(log.recordsSince(log.marks()).length, 0)

  // THE rebalance case (why scoped keys by (origin,partition)): a node that holds
  // A.x and A.y but is ACQUIRING z has no mark for B.z, so all of z ships — even
  // though z.seq (1) sits BELOW A's high-water (5). A per-origin mark of {A:5}
  // would have wrongly suppressed it, silently losing the partition.
  assert.deepEqual(
    log.recordsSince({ [originKey('A', 'x')]: 5, [originKey('A', 'y')]: 2 }).map((r) => [partitionOf(r), r.seq]),
    [['z', 1]],
  )
})

// ── compaction (collapse superseded same-key updates) ────────────────────────

test('compact collapses superseded same-key updates; preserves marks + replay state (full)', () => {
  const log = new Log()
  // one origin churns 3 keys in partition p, 4 rounds each — 12 records, 3 live.
  let seq = 0
  const all: ChangeRecord[] = []
  for (let round = 0; round < 4; round++)
    for (const k of ['a', 'b', 'c']) {
      const r: ChangeRecord = { type: 'update', key: ['p', k], value: round * 10 + k.charCodeAt(0), origin: 'O', seq: ++seq, epoch: 1 }
      all.push(r)
      log.append(r)
    }
  const marksBefore = log.marks()
  const stateBefore = stable(view(log)[value])

  const dropped = log.compact()

  assert.equal(dropped, 9, 'drops the 9 superseded updates (keeps 1 per key)')
  assert.equal(log.size, 3, 'segment collapsed to the 3 live keys')
  assert.deepEqual(log.marks(), marksBefore, 'marks() preserved EXACTLY (group max-seq never dropped)')
  assert.equal(stable(view(log)[value]), stateBefore, 'a from-0 replay of the compacted log is the same state')
  // a fresh peer (empty vector) converges to the same state as replaying the FULL pre-compaction history
  assert.equal(stable(stateOf(log.recordsSince({}))), stable(stateOf(all)), 'fresh-peer catch-up converges to the live state')
})

test('compact converges a LAGGING peer (mid-mark) the same as the uncompacted log would', () => {
  const full = new Log() // reference: never compacted
  const comp = new Log() // compacted
  let seq = 0
  for (let round = 0; round < 5; round++)
    for (const k of ['x', 'y']) {
      const r: ChangeRecord = { type: 'update', key: ['p', k], value: round, origin: 'O', seq: ++seq, epoch: 1 }
      full.append({ ...r })
      comp.append({ ...r })
    }
  comp.compact()
  // a peer caught up to seq 4 gets the rest from each log → identical converged state
  const fromFull = stateOf(full.recordsSince({ O: 4 }))
  const fromComp = stateOf(comp.recordsSince({ O: 4 }))
  assert.equal(stable(fromFull), stable(fromComp), 'lagging-peer catch-up identical compacted vs uncompacted')
})

test('compact never drops positional inserts (arrays)', () => {
  // two array inserts at the same position are DISTINCT elements (each splices) — never collapsed
  const arr = new Log()
  arr.append({ type: 'insert', key: ['list'], value: 'A', at: 0, origin: 'O', seq: 1, epoch: 1 })
  arr.append({ type: 'insert', key: ['list'], value: 'B', at: 0, origin: 'O', seq: 2, epoch: 1 })
  assert.equal(arr.compact(), 0, 'positional inserts (same versionKey, distinct elements) are kept')
})

test('compact leaves a partition with a NESTED remove untouched (no orphan-tombstone crash on replay)', () => {
  // THE blocker the impl review caught: a set/delete/set cycle on a nested field. If we dropped the
  // first update (dominated by the third), the remove would replay BEFORE any vivifier → res.remove of
  // an absent ancestor THROWS, tearing a fresh joiner's catch-up. A nested remove (key.length≥2) makes
  // the whole partition non-compactable, so the original vivifier survives and replay is safe.
  const t = new Log()
  t.append({ type: 'update', key: ['lock', 'held'], value: true, origin: 'O', seq: 1, epoch: 1 })
  t.append({ type: 'remove', key: ['lock', 'held'], origin: 'O', seq: 2, epoch: 1 })
  t.append({ type: 'update', key: ['lock', 'held'], value: false, origin: 'O', seq: 3, epoch: 1 })
  assert.equal(t.compact(), 0, 'a nested remove in the segment ⇒ nothing dropped (conservative)')
  // a fresh peer catching up from the (un)compacted log replays without crashing, to the live state
  assert.doesNotThrow(() => stateOf(t.recordsSince({})), 'catch-up replay does not crash')
  assert.equal(stable(stateOf(t.recordsSince({}))), stable({ lock: { held: false } }), 'converges to the live state')

  // a TOP-LEVEL remove of a missing key is a replay no-op, so it does NOT block compaction of a
  // sibling partition's churn (verified in resource end-to-end too).
  const top = new Log()
  for (let i = 0; i < 4; i++) top.append({ type: 'update', key: ['x'], value: i, origin: 'O', seq: i + 1, epoch: 1 })
  top.append({ type: 'remove', key: ['y'], origin: 'O', seq: 5, epoch: 1 }) // partition 'y', top-level
  assert.equal(top.compact(), 3, "x's churn still collapses (a top-level remove doesn't block)")
  assert.equal(stable(view(top)[value]), stable({ x: 3 }), 'x at its latest value; y never existed')
})

test('compact selects by LWW (epoch,seq), not raw max-seq — an epoch inversion keeps both', () => {
  // stable-uuid restart: Lamport clock restored but view epoch reset, so a higher-seq
  // local write can carry a LOWER epoch than a restored record — it is NOT the winner.
  const inv = new Log()
  inv.append({ type: 'update', key: ['k'], value: 'winner@epoch2', origin: 'O', seq: 1, epoch: 2 })
  inv.append({ type: 'update', key: ['k'], value: 'newerSeq@epoch1', origin: 'O', seq: 2, epoch: 1 })
  assert.equal(inv.compact(), 0, 'neither dominates (higher seq has lower epoch) → keep both, no winner lost')
  assert.deepEqual(inv.marks(), { O: 2 }, 'marks unchanged')

  // a genuine epoch climb (higher epoch AND higher seq) DOES collapse to the winner
  const climb = new Log()
  climb.append({ type: 'update', key: ['k'], value: 'old', origin: 'O', seq: 1, epoch: 1 })
  climb.append({ type: 'update', key: ['k'], value: 'new', origin: 'O', seq: 2, epoch: 2 })
  assert.equal(climb.compact(), 1, 'higher (epoch,seq) dominates → the loser is dropped')
  assert.equal(stable(view(climb)[value]), stable({ k: 'new' }), 'the LWW winner survives')
})

test('compact is intra-origin: a cross-origin loser is never dropped (LWW resolves it at the receiver)', () => {
  const log = new Log()
  log.append({ type: 'update', key: ['k'], value: 'A1', origin: 'A', seq: 1, epoch: 1 })
  log.append({ type: 'update', key: ['k'], value: 'A2', origin: 'A', seq: 2, epoch: 1 }) // A supersedes A1
  log.append({ type: 'update', key: ['k'], value: 'B1', origin: 'B', seq: 1, epoch: 1 }) // different origin group
  const dropped = log.compact()
  assert.equal(dropped, 1, "only A's own superseded A1 is dropped; B1 (cross-origin) is kept")
  assert.deepEqual(log.marks(), { A: 2, B: 1 }, 'both origins still advertised')
})

test('compact (scoped): per-(origin,partition) collapse keeps the acquire-from-0 digest intact', () => {
  const log = new Log({ scoped: true })
  let seq = 0
  for (let round = 0; round < 6; round++) log.append({ type: 'update', key: ['x', 'f'], value: round, origin: 'A', seq: ++seq, epoch: 1 })
  log.append({ type: 'update', key: ['y', 'f'], value: 'y', origin: 'A', seq: ++seq, epoch: 1 })
  const marksBefore = log.marks()

  assert.equal(log.compact(), 5, 'x.f collapses 6→1; y.f untouched')
  assert.equal(log.size, 2, 'two live keys remain')
  assert.deepEqual(log.marks(), marksBefore, 'scoped per-(origin,partition) marks preserved')
  // an acquirer with no mark for y still gets all of y (the rebalance case still works post-compaction)
  assert.deepEqual(
    log.recordsSince({ [originKey('A', 'x')]: seq }).map((r) => [partitionOf(r), r.seq]),
    [['y', seq]],
  )
})

test('compact is a no-op below min and on provenance-less records', () => {
  const log = new Log()
  log.append({ type: 'update', key: ['p', 'a'], value: 1, origin: 'O', seq: 1, epoch: 1 })
  log.append({ type: 'update', key: ['p', 'a'], value: 2, origin: 'O', seq: 2, epoch: 1 })
  assert.equal(log.compact({ min: 3 }), 0, 'segment shorter than min is skipped')
  // provenance-less records (handshake / non-fero) are never grouped or dropped
  const pl = new Log()
  pl.append({ type: 'update', key: ['p', 'a'], value: 1 })
  pl.append({ type: 'update', key: ['p', 'a'], value: 2 })
  assert.equal(pl.compact(), 0, 'no origin → never collapsed')
  assert.equal(pl.size, 2)
})
