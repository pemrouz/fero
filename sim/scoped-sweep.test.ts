//! The scoped adversarial sweep (DESIGN-SCALE stage 0, §6): the adversaries A1-A11 of sim/scoped-sweep.ts, each run
// on seeded scoped clusters (n from the family's list, R 1-3, memory or durable, 50-500 partitions, row and field
// writes, removes, re-writes of removed cells; compactAt and snapshotAt at 16) with M1-M9 armed, and the mutation
// runner's pinned catches.
//
// Lawful runs, per seed: no monitor fires and M1's horizon form agrees (SAFE); holders converge, exactly-R holds and
// the holders' floors agree at the horizon (LIVE); M8 is red (RED TODAY by design: logs are unbounded under
// scoping) and M9 is red only at R=1 (the leave does not drain). Per family, an engagement count proves the chaos bit.
//
// Mutations: today's kernel never releases an armed tombstone, so M3 and M6 check nothing in a lawful run. The
// mutation runner performs the releases a broken rule would (sim/scoped-sweep.ts inject), and the pinned schedules
// below must turn M1, M3 or M6 red. Measured on 3 seeds per family (2026-10-09): `release-all` (the release step
// with no census and no lane accounting) is caught in all 11 families; `drop-one` (one tombstone and its record at
// one holder) only in A6, and in A1/A2/A7/A10 under earlier timings: it needs that one holder to teach the
// partition later; `version-only` (G1: the stamp goes, every lane keeps its entries) in A1 and A11 only. On today's
// kernel the remove's entry stays in every lane, so a refold re-derives the tombstone; G1 bites only where an older
// record still arrives above the fence (A1's zombie after the heal, A11's re-downloading spoke). Stage 3's
// compaction drops that entry, and its mutation must then be caught across the families.
// Cost: about 25 s at low priority on this box (2 seeds per family, then five pinned mutation schedules, each run
// clean and mutated). More seeds: FERO_SCOPED_SEEDS=N (8 per family took about 70 s on 2026-10-09). The known-unsafe set below is exact in both directions
// for whatever range runs.

import { test } from 'node:test'
import assert from 'node:assert'
import { FAMILIES, runFamily, familyByName, CATCHERS, type Mutation } from './scoped-sweep.ts'

const SEEDS = Number(process.env.FERO_SCOPED_SEEDS ?? 2)

//! KNOWN_UNSAFE — schedules today's kernel is not safe on, each with its finding. A11 seed 5: a spoke's resync ends
// on a STALE digest reply. The spoke asked its new feeder for a digest (r=1); the reply's records and r=0 are in
// flight when the spoke decides to resync (fold wiped, an empty r=1 sent); the old r=0 then lands and is taken as
// the resync's completion marker (node.ts #resyncEnd), so the ghost sweep runs with almost nothing re-downloaded,
// and the real re-download arrives afterwards one record run per frame: for a few events the spoke shows cells
// whose removes are still in flight (M1). The end state is right; the screen flickers. Found by this sweep.
// A3 seed 6: one attempt commits TWICE across ownership moves on a scoped cluster (the existing attempt-exactly-once
// monitor): n05's forwarded field remove of p58.f2 (cid 19) commits at n01 (epoch 1, seq 35) and again at n04
// (epoch 4, seq 49), after two joins and an orphan cut moved the partition. The new owner's dedup window never
// learned the first commit: under scoping it learns cids only from records of partitions it holds, and the latch
// carries no dedup tuples yet (DESIGN-SCALE stage 3 plans ACQDONE `w`). A re-committed remove can erase a newer
// write. Found by this sweep.
const KNOWN_UNSAFE: Record<string, number[]> = { 'A3-orphan-cut': [6], 'A11-spoke': [5] }

//! the engagement key each family must hit on at least one seed: a family whose chaos never bit proves nothing
const ENGAGED: Record<string, (e: Record<string, number>) => boolean> = {
  'A1-zombie': (e) => e.stranded === 1 && e.epoch >= 3, // stranded, evicted, healed back in
  'A2-slow-owner-join': (e) => e.epoch >= 2 && e.acquires > 0,
  'A3-orphan-cut': (e) => e.orphanCut === 1,
  'A4-restarts': (e) => e.restarts === 2,
  'A5-view-severed': (e) => e.epoch >= 2 && e.sheds > 0,
  'A6-flip-mid-latch': (e) => e.flip === 1 && e.epoch >= 3,
  'A7-down-to-one': (e) => e.left > 0 && e.leaves > 0,
  'A8-coholder-cut': (e) => e.epoch >= 2 && e.acquires > 0,
  'A9-lost-wack': (e) => e.wackCut === 1 && e.epoch >= 2,
  'A10-linger': (e) => e.killed === 1 && e.onWire === 1, // representable only up to the wire: see the family
  'A11-spoke': (e) => e.paused === 1,
}

for (const fam of FAMILIES) {
  test(`scoped sweep ${fam.name}: ${SEEDS} seeds — safe and live, M8 red today on every seed, M9 only at R=1, the chaos engaged`, () => {
    const unsafe: string[] = [], notLive: string[] = [], newlySafe: number[] = []
    let engaged = 0, cells = 0, advances = 0
    const known = new Set(KNOWN_UNSAFE[fam.name] ?? [])
    for (let seed = 1; seed <= SEEDS; seed++) {
      const o = runFamily(fam, seed)
      if (o.unsafe.length) { if (!known.has(seed)) unsafe.push(`${o.shape}: ${o.unsafe.join(' | ')}`) }
      else if (known.has(seed)) newlySafe.push(seed)
      if (o.notLive.length) notLive.push(`${o.shape}: ${o.notLive.join(' | ')}`)
      assert.ok(o.redToday.includes('M8'), `${o.shape}: M8 is red today on every scoped run with a remove (if green, stage 3/4 landed: flip the pin)`)
      if (o.redToday.includes('M9')) assert.ok(o.shape.includes(' R=1'), `${o.shape}: M9 only at R=1`)
      if (ENGAGED[fam.name](o.eng)) engaged++
      cells += o.eng.cells; advances += o.eng.advances
    }
    assert.deepEqual(unsafe, [], 'UNSAFE: a monitor fired or M1\'s horizon form disagrees')
    assert.deepEqual(newlySafe, [], 'a schedule pinned unsafe is safe now: take it off KNOWN_UNSAFE, with the why')
    assert.deepEqual(notLive, [], 'not live at the horizon')
    assert.ok(engaged > 0, `${fam.name}: the chaos never engaged on ${SEEDS} seeds`)
    assert.ok(cells > 0 && advances > 0, `${fam.name}: non-vacuity — M1 checked ${cells} cells, M5 ${advances} floor advances`)
  })
}

//! the mutation runner's pinned catches: each schedule is green unmutated and red (M1, M3 or M6) with the mutation
const CAUGHT: [string, number, Mutation, string[]][] = [
  ['A1-zombie', 1, 'release-all', ['stamp-oracle', 'release-safety', 'census-truth']], // M6 at the release: the zombie still holds an older record
  ['A1-zombie', 1, 'version-only', ['stamp-oracle', 'release-safety', 'census-truth']], // G1: the zombie's write lands above the fence after the heal
  ['A7-down-to-one', 2, 'release-all', ['stamp-oracle', 'release-safety']], // a re-joiner is taught the dead writes
  ['A6-flip-mid-latch', 3, 'drop-one', ['release-safety']], // the dropping holder teaches the partition after the flip
  ['A11-spoke', 2, 'version-only', ['release-safety']], // the spoke's re-download applies an old write under a released stamp
]

test('mutation runner: today\'s injected-drop class — each pinned schedule is green as is and caught by the named monitors when the release rule is weakened', () => {
  for (const [name, seed, mut, by] of CAUGHT) {
    const fam = familyByName(name)
    const clean = runFamily(fam, seed)
    assert.deepEqual(clean.unsafe, [], `${clean.shape}: green without the mutation`)
    const o = runFamily(fam, seed, mut)
    assert.equal(o.eng.mutated, 1, `${o.shape}: the mutation found a tombstone to release`)
    const caught = [...o.red].filter((m) => CATCHERS.has(m)).sort()
    assert.deepEqual(caught, [...by].sort(), `${o.shape}: caught by ${caught.join('+') || 'nothing'}`)
  }
})
