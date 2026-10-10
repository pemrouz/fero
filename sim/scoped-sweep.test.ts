//! The scoped adversarial sweep (DESIGN-SCALE stage 0, §6): the adversaries A1-A11 of sim/scoped-sweep.ts, each run
// on seeded scoped clusters (n from the family's list, R 1-3, memory or durable, 50-500 partitions, row and field
// writes, removes, re-writes of removed cells; compactAt and snapshotAt at 16) with M1-M10 armed, and the mutation
// runner's pinned catches.
//
// Lawful runs, per seed: no monitor fires and M1's horizon form agrees (SAFE); holders converge, exactly-R holds and
// the holders' floors agree at the horizon (LIVE); M8 is red (RED TODAY by design: logs are unbounded under
// scoping). M9 (leave drain) was red at R=1 until the drain landed (DESIGN-SCALE §7 stage 1 (b), 2026-10-10): a
// clean leaver now hands what it held to the new holders before it goes, so a leave-drain violation is UNSAFE
// like any other; A7 always runs its seed 4 (n=2 R=1), the one shape at the battery's seed count where that check
// can bite. Per family, an engagement count proves the chaos bit.
//
// Mutations: today's kernel never releases an armed tombstone, so M3 and M6 check nothing in a lawful run. The
// mutation runner performs the releases a broken rule would (sim/scoped-sweep.ts inject), and the pinned schedules
// below must turn M1, M3 or M6 red. Measured on 3 seeds per family (2026-10-09): `release-all` (the release step
// with no census and no lane accounting) is caught in all 11 families; `drop-one` (one tombstone and its record at
// one holder) only in A6, and in A1/A2/A7/A10 under earlier timings: it needs that one holder to teach the
// partition later; `version-only` (G1: the stamp goes, every lane keeps its entries) in A1 and A11 only. On today's
// kernel the remove's entry stays in every lane, so a refold re-derives the tombstone; G1 bites only where an older
// record still arrives above the fence (A1's zombie after the heal, A11's spoke). Stage 3's
// compaction drops that entry, and its mutation must then be caught across the families.
// Cost: about 50 s at low priority on this box (2 seeds per family plus the pinned unsafe seeds, then five
// pinned mutation schedules, each run clean and mutated). More seeds: FERO_SCOPED_SEEDS=N (8 per family took about
// 70 s on 2026-10-09, before the pinned seeds were added). The known-unsafe seeds below run in every battery on top
// of that range, each pinned to the monitor line it fails on, and the set is exact in both directions over the
// seeds that were checked: 1-8 for every family, and 1-12 for A11. Above that, a new red is a finding to read,
// not a broken test.

import { test } from 'node:test'
import assert from 'node:assert'
import { FAMILIES, runFamily, familyByName, CATCHERS, type Mutation } from './scoped-sweep.ts'

const SEEDS = Number(process.env.FERO_SCOPED_SEEDS ?? 2)

//! KNOWN_UNSAFE — schedules today's kernel is not safe on, each with its finding and the monitor that names it.
// A11 seeds 2, 5, 6 and 10: a spoke's resync ends on a STALE digest reply (M10 resync-end), on every A11 seed that
// fails over to a feeder behind it (2, 5, 6 and 10 of seeds 1-12). At the failover the spoke sends its new feeder
// a digest (r=1, #0). The feeder's own r=1 crosses it and shows a lane tail below the spoke's, so the spoke
// resyncs: fold wiped, an empty r=1 (#1) sent to ask for the re-download. The feeder's r=0 reply to #0 then
// lands and is taken as the resync's end (node.ts #resyncEnd), so the ghost sweep runs before anything was
// re-downloaded, and the real re-download lands after it, one record run per frame. For those events the spoke
// shows older values of live rows (seed 6: p29 at seq 21 after seq 69) and, on seed 5, a row whose remove is
// still on the way (M1). The end state is right; the screen goes back in time. Found by this sweep.
// A3 seed 6: one attempt commits TWICE across an ownership move (the existing attempt-exactly-once monitor):
// n05's forwarded field remove of p58.f2 (cid 19) commits at n01 (t=1858.8, epoch 1, seq 35); 1.5 ms later the
// orphan cut takes every n01 link down, before the commit's fan-out or its WACK left n01, so no other node holds
// n01:35 and n05 never learns it committed. n05 retries; n04, the owner by then, commits it again (epoch 4, seq
// 49). After the heal n01:35 reaches n04 (t=3297) and both commits stand. The latch is not the gap: it feeds every
// taught record's attempt identity into the dedup window (kernel/scope.ts, `remember` in the ACQDONE fold), but no
// teacher ever held n01:35. This is the unscoped zombie's class (a commit stranded on a cut-off owner), seen here
// as a double commit, so its fix belongs with the zombie's (what a cut-off owner committed but never shipped),
// not with the latch's dedup tuples. A re-committed remove can erase a newer write. Found by this sweep.
const KNOWN_UNSAFE: Record<string, Record<number, RegExp>> = {
  'A3-orphan-cut': { 6: /attempt-exactly-once .*committed TWICE/ },
  'A11-spoke': { 2: /resync-end .*stale reply/, 5: /resync-end .*stale reply/, 6: /resync-end .*stale reply/, 10: /resync-end .*stale reply/ },
}

//! ALWAYS — shapes a family must reach in every battery, whatever SEEDS is, because a pin below is vacuous without
// them. A7 seed 4 is n=2 R=1 (seeds 1-3 are all R=2): the one shape where the leaver alone holds rows, so the only
// one on which M9's leave-drain check can bite. With the drain removed it is the seed that goes red (checked
// 2026-10-10: base tree red=[leave-drain] on seed 4 alone of seeds 1-4; the branch green).
const ALWAYS: Record<string, number[]> = {
  'A7-down-to-one': [4],
}

//! the engagement key each family must hit on at least one seed: a family whose chaos never bit proves nothing
const ENGAGED: Record<string, (e: Record<string, number>) => boolean> = {
  'A1-zombie': (e) => e.stranded === 1 && e.epoch >= 3, // stranded, evicted, healed back in
  'A2-slow-owner-join': (e) => e.stale > 0, // a demoted owner committed at the old epoch for a partition that already moved
  'A3-orphan-cut': (e) => e.orphanCut === 1,
  'A4-restarts': (e) => e.restarts === 2,
  'A5-view-severed': (e) => e.epoch >= 2 && e.sheds > 0,
  'A6-flip-mid-latch': (e) => e.flip === 1 && e.epoch >= 3,
  'A7-down-to-one': (e) => e.left > 0 && e.leaves > 0,
  'A8-coholder-cut': (e) => e.epoch >= 2 && e.acquires > 0,
  'A9-lost-wack': (e) => e.wackCut === 1 && e.epoch >= 2,
  'A10-linger': (e) => e.killed === 1 && e.late > 0, // a killed member's record applied after the survivor's install
  'A11-spoke': (e) => e.paused === 1,
}

for (const fam of FAMILIES) {
  test(`scoped sweep ${fam.name}: ${SEEDS} seeds${KNOWN_UNSAFE[fam.name] ? ', pinned unsafe ' + Object.keys(KNOWN_UNSAFE[fam.name]).join(',') : ''}${ALWAYS[fam.name] ? ', always ' + ALWAYS[fam.name].join(',') : ''} — safe and live, M8 red today on every seed, the chaos engaged`, () => {
    const unsafe: string[] = [], notLive: string[] = [], newlySafe: number[] = []
    let engaged = 0, cells = 0, advances = 0, resyncs = 0
    const pins = KNOWN_UNSAFE[fam.name] ?? {}
    const known = new Set(Object.keys(pins).map(Number))
    //! every pinned unsafe seed runs in every battery, whatever SEEDS is: a pin that never runs proves nothing, and
    // the newly-safe check below is the flip a fix must make; the ALWAYS shapes run for the same reason
    const seeds = [...new Set([...Array.from({ length: SEEDS }, (_, i) => i + 1), ...known, ...(ALWAYS[fam.name] ?? [])])]
    for (const seed of seeds) {
      const o = runFamily(fam, seed)
      if (o.unsafe.length) {
        if (!known.has(seed)) unsafe.push(`${o.shape}: ${o.unsafe.join(' | ')}`)
        else assert.match(o.unsafe.join(' | '), pins[seed], `${o.shape}: unsafe for the pinned reason`)
      }
      else if (known.has(seed)) newlySafe.push(seed)
      if (o.notLive.length) notLive.push(`${o.shape}: ${o.notLive.join(' | ')}`)
      assert.ok(o.redToday.includes('M8'), `${o.shape}: M8 is red today on every scoped run with a remove (if green, stage 3/4 landed: flip the pin)`)
      assert.ok(!o.red.has('leave-drain'), `${o.shape}: M9 red — a clean leaver took the only copy of a row with it (the drain, DESIGN-SCALE stage 1 (b), should have held it)`)
      if (ENGAGED[fam.name](o.eng)) engaged++
      cells += o.eng.cells; advances += o.eng.advances; resyncs += o.eng.resyncs
    }
    assert.deepEqual(unsafe, [], 'UNSAFE: a monitor fired or M1\'s horizon form disagrees')
    assert.deepEqual(newlySafe, [], 'a schedule pinned unsafe is safe now: take it off KNOWN_UNSAFE, with the why')
    assert.deepEqual(notLive, [], 'not live at the horizon')
    assert.ok(engaged > 0, `${fam.name}: the chaos never engaged on seeds ${seeds.join(',')}`)
    if (fam.name === 'A11-spoke') assert.ok(resyncs > 0, 'non-vacuity: M10 saw a spoke\'s resync end')
    assert.ok(cells > 0 && advances > 0, `${fam.name}: non-vacuity — M1 checked ${cells} cells, M5 ${advances} floor advances`)
  })
}

//! the mutation runner's pinned catches: each schedule is green unmutated and red (M1, M3 or M6) with the mutation
const CAUGHT: [string, number, Mutation, string[]][] = [
  ['A1-zombie', 1, 'release-all', ['stamp-oracle', 'release-safety', 'census-truth']], // M6 at the release: the zombie still holds an older record
  ['A1-zombie', 1, 'version-only', ['stamp-oracle', 'release-safety', 'census-truth']], // G1: the zombie's write lands above the fence after the heal
  ['A7-down-to-one', 2, 'release-all', ['stamp-oracle', 'release-safety']], // a re-joiner is taught the dead writes
  ['A6-flip-mid-latch', 3, 'drop-one', ['release-safety']], // the dropping holder teaches the partition after the flip
  ['A11-spoke', 3, 'version-only', ['release-safety']], // the spoke applies an old write under a released stamp
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
