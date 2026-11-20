// E-58 part 3: a write that spans partitions lands as one commit per partition (v5 has no order across partitions:
// API.md 3.6, "across partitions there is no all-or-none write"). How many mixed states does a reader of two partitions
// see while it lands? On data's real engine: one source, a separate data commit per partition, readers on data's
// per-path connect.
//   A. a root replace at depth 1: K rows (2 to 8), each its own partition, all set to generation g. The K commits arrive
//      in a random order, with other writers' field writes in between. Readers: a callback on two rows' `gen` fields
//      (it sees every commit), a loop on the same two that wakes after 1 to 4 commits and reads the newest state, and a
//      callback on the whole resource. A mixed state: two rows of different generations.
//   B. a move of a row between two partitions at depth 2 (remove from one room, add to the other): two commits in a
//      random order. A mixed state: the row in both rooms, or in neither.
//   C. the control and the pick: the same root replace as ONE data commit, and a room replace at depth 2 done as one
//      batch inside the room (what `room.set(rows)` would be if the leader expanded it): 0 mixed states, checked.
// Planted bug (E58_MUTATE=splitrows): C's room replace is done as one commit per row; C must then fail.
import { D, SourceNode } from '../../E55-lens-prototype/proto/lens.mjs'
import { MUT, rng, inc } from './common.mjs'

function reader(src, rowKey, field, out) {
  return D.handleFor(src).get(rowKey).get(field).connect({}, out, { clone: false })
}

export function runSeed(seed, S) {
  const r = rng(seed)
  const failed = new Set()
  const fail = (k) => { inc(S, 'FAIL:' + k); failed.add(k) }

  // ── A: a root replace split into one commit per partition ──
  {
    const rt = new D.Runtime()
    const K = 2 + r.int(7)
    const keys = Array.from({ length: K }, (_, i) => 'r' + i)
    const seedRows = Object.fromEntries(keys.map((k) => [k, { gen: 0, v: 0 }]))
    const src = new SourceNode(rt, seedRows)
    // the two-row reader: the newest gen of each row it has heard of
    const seen = { r0: 0, r1: 0 }
    let firedThisCommit = false
    const hs = ['r0', 'r1'].map((k) => reader(src, k, 'gen', (rec) => { if (rec.key.length === 0 && rec.value !== undefined) { seen[k] = rec.value; firedThisCommit = true } }))
    firedThisCommit = false // the picture each reader got at connect is not a commit
    // the whole-resource reader: a raw sink; after each commit it fired on, are all rows one generation?
    let wholeFired = false
    const hw = src.connect({ wantsOrder: false, origin: null, apply: () => { wholeFired = true } })
    // the loop reader: wakes after 1 to 4 commits and reads the newest state of its two rows
    let untilWake = 1 + r.int(4), loopDirty = false
    let gen = 0
    const unrelated = () => { const k = r.pick(keys); src.write(k, ['v'], (src.get(k).v ?? 0) + 1) }
    for (let rep = 0; rep < 20; rep++) {
      gen++
      inc(S, 'A:root-replaces'); inc(S, 'A:partition-commits', K)
      const order = keys.slice().sort(() => r() - 0.5)
      let cbMixed = 0, loopMixed = 0, wholeMixed = 0
      const after = () => {
        const g0 = src.get('r0').gen, g1 = src.get('r1').gen
        if (firedThisCommit) { inc(S, 'A:two-row-callbacks'); if (seen.r0 !== seen.r1) cbMixed++ }
        if (wholeFired) { inc(S, 'A:whole-callbacks'); const gs = new Set(keys.map((k) => src.get(k).gen)); if (gs.size > 1) wholeMixed++ }
        if (firedThisCommit) loopDirty = true
        if (--untilWake === 0) { untilWake = 1 + r.int(4); if (loopDirty) { inc(S, 'A:loop-turns'); loopDirty = false; if (g0 !== g1) loopMixed++ } }
        firedThisCommit = false; wholeFired = false
      }
      for (const k of order) {
        rt.batch(() => src.write(k, [], { gen, v: src.get(k).v }))
        after()
        if (r() < 0.3) { rt.batch(unrelated); after() }
      }
      inc(S, 'A:mixed-two-row-callback-states', cbMixed); if (cbMixed > 0) inc(S, 'A:replaces-with-mixed-two-row-callback')
      inc(S, 'A:mixed-loop-turns', loopMixed); if (loopMixed > 0) inc(S, 'A:replaces-with-mixed-loop-turn')
      inc(S, 'A:mixed-whole-callback-states', wholeMixed); if (wholeMixed > 0) inc(S, 'A:replaces-with-mixed-whole-callback')
    }
    for (const h of hs) h.dispose(); hw.dispose()
  }

  // ── B: a row moved between two partitions (depth 2: a remove in one room, an add in the other) ──
  {
    const rt = new D.Runtime()
    const rooms = [new SourceNode(rt, { m: { text: 'hi' } }), new SourceNode(rt, {})]
    let where = 0
    const present = [true, false]
    let fired = false
    const hs = rooms.map((s, i) => D.handleFor(s).get('m').connect({}, (rec) => { if (rec.key.length === 0) { present[i] = rec.type !== 'remove' && rec.value !== undefined; fired = true } }, { clone: false }))
    fired = false
    let untilWake = 1 + r.int(4), dirty = false
    for (let mv = 0; mv < 20; mv++) {
      inc(S, 'B:moves')
      const from = where, to = 1 - where
      const steps = r() < 0.5 ? ['remove', 'add'] : ['add', 'remove']
      let cbMixed = 0, loopMixed = 0
      for (const st of steps) {
        rt.batch(() => { if (st === 'remove') rooms[from].remove('m'); else rooms[to].write('m', [], { text: 'hi' + mv }) })
        if (fired) { inc(S, 'B:callbacks'); if (present[0] === present[1]) cbMixed++ ; dirty = true }
        fired = false
        if (--untilWake === 0) { untilWake = 1 + r.int(4); if (dirty) { dirty = false; inc(S, 'B:loop-turns'); if (rooms[0].hasRow('m') === rooms[1].hasRow('m')) loopMixed++ } }
      }
      where = to
      if (cbMixed > 0) inc(S, 'B:moves-with-mixed-callback-state')
      if (loopMixed > 0) inc(S, 'B:moves-with-mixed-loop-turn')
      inc(S, steps[0] === 'remove' ? 'B:remove-first' : 'B:add-first')
    }
    for (const h of hs) h.dispose()
  }

  // ── C: the control (a root replace as one data commit) and the pick (a room replace as one batch in the room) ──
  {
    const rt = new D.Runtime()
    const K = 2 + r.int(7)
    const keys = Array.from({ length: K }, (_, i) => 'r' + i)
    const src = new SourceNode(rt, Object.fromEntries(keys.map((k) => [k, { gen: 0 }])))
    const seen = { r0: 0, r1: 0 }
    let fired = false
    const hs = ['r0', 'r1'].map((k) => reader(src, k, 'gen', (rec) => { if (rec.key.length === 0 && rec.value !== undefined) { seen[k] = rec.value; fired = true } }))
    fired = false
    for (let rep = 1; rep <= 20; rep++) {
      inc(S, 'C:replaces')
      // a room replace: the leader expands room.set(rows) into one batch of row writes in the room
      if (MUT === 'splitrows') for (const k of keys) { rt.batch(() => src.write(k, [], { gen: rep })); if (fired && seen.r0 !== seen.r1) fail('C:mixed'); fired = false }
      else { rt.batch(() => { for (const k of keys) src.write(k, [], { gen: rep }) }); if (fired && seen.r0 !== seen.r1) fail('C:mixed'); fired = false }
      inc(S, 'C:commits', MUT === 'splitrows' ? K : 1)
    }
    for (const h of hs) h.dispose()
  }
  return failed
}
