//! The scoped adversarial sweep (DESIGN-SCALE stage 0, §6): the adversaries A1-A11 of sim/scoped-sweep.ts (and, since
// wave 6a, A12, the spoke across two hand-offs, and A13, the spoke whose feeder repairs and re-enters through the latch,
// with M12 judging every spoke against its feeder's held subset), each run
// on seeded scoped clusters (n from the family's list, R 1-3, memory or durable, 50-500 partitions, row and field
// writes, removes, re-writes of removed cells; compactAt and snapshotAt at 16) with M1-M10 armed, and the mutation
// runner's pinned catches.
//
// Lawful runs, per seed: no monitor fires and M1's horizon form agrees (SAFE); holders converge, exactly-R holds,
// the holders' floors agree at the horizon and every holder's marks of each co-holder equal that co-holder's floors
// (M7's two forms: floors-agree and marks-agree — LIVE); M8's LANE half is green (since DESIGN-SCALE stage 3,
// 2026-10-12: every lane at or under winners + compactAt at the horizon — a lane over it is NOT LIVE; at this
// workload it would hold with compaction off too, so the per-family compaction count below is what proves the pass
// runs, and P4 is where the bound bites) and its TOMBSTONE half red (RED TODAY by design: no pin surface until stage
// 4; M2 frontier-sound judges every compaction pass in every family, and every family compacts — eng.compactions).
// M9 (leave drain) was red at R=1 until the drain landed (DESIGN-SCALE §7 stage 1 (b), 2026-10-10): a
// clean leaver now hands what it held to the new holders before it goes, so a leave-drain violation is UNSAFE
// like any other; A7 always runs its seed 4 (n=2 R=1), the one shape at the battery's seed count where that check
// can bite. Per family, an engagement count proves the chaos bit.
//
// Stage-2 mutations (announce-on-change, 2026-10-10): the sweep switched off and the dirty site dropped must each be
// caught (DESIGN-SCALE §6, §7's stage-2 gate). M7's floor form cannot catch either — the sim loses no frame on a
// live link, and every loss it can make is healed by a round of its own — so the catch is M7's KNOWLEDGE form
// (sim/monitors.ts marksAgree), pinned below on A8 (the §6 family for lost announcements): seed 3 (R=3) for the
// sweep, seed 1 (R=2) for the dirty site, with the sweep-off run on seed 1 as the control that is green.
//
// Mutations: today's kernel never releases an armed tombstone, so M3 and M6 check nothing in a lawful run. The
// mutation runner performs the releases a broken rule would (sim/scoped-sweep.ts inject), and the pinned schedules
// below must turn M1, M3 or M6 red. Measured on 3 seeds per family (2026-10-09): `release-all` (the release step
// with no census and no lane accounting) is caught in all 11 families; `drop-one` (one tombstone and its record at
// one holder) only in A6, and in A1/A2/A7/A10 under earlier timings: it needs that one holder to teach the
// partition later; `version-only` (G1: the stamp goes, every lane keeps its entries) in A1 and A11 only. Before stage
// 3 the remove's entry stayed in every lane, so a refold re-derived the tombstone; G1 bit only where an older record
// still arrived above the fence (A1's zombie after the heal, A11's spoke). SINCE STAGE 3 (2026-10-12) compaction
// drops the remove's entry once its stamp is gone (it is no winner), and the next teach or spoke forward ships the
// older record without it: `version-only` is caught on A1 seeds 1-8, A3 seeds 5-7, A11 seeds 5-7 and A12 seeds 1, 2,
// 5, 7 (scanned seeds 1-8 of every family). The same pass takes `drop-one`'s bite away on most seeds: the older
// write under the dropped remove is already compacted at that holder when the mutation fires, so its later teach
// has nothing to resurrect; it is caught where an older record survives outside the frontier — the zombie's
// stranded lane (A1 seed 8), and A4 seed 6. The runner drops a remove's OWN entry (its stamp and its cell): until
// 2026-10-21 it matched by stamp alone and, for a field a row write swept, dropped the parent row's winning entry,
// which is what A7 seed 5 and A2 seed 14 caught (the pins below say how they moved).
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
// A11 seeds 2, 5, 6 and 10 WERE pinned here (2026-10-09): a spoke's resync ended on a STALE digest reply (M10
// resync-end) on every A11 seed that fails over to a feeder behind it. At the failover the spoke sent its new feeder
// a digest (r=1, #0); the feeder's own r=1 crossed it and showed a lane tail below the spoke's, so the spoke resynced
// (fold wiped, an empty r=1 #1); the feeder's r=0 reply to #0 then landed and was taken as the resync's end, so the
// ghost sweep ran before anything was re-downloaded and the re-download landed after it, one record run per frame:
// the spoke showed older values of live rows (seed 6: p29 at seq 21 after seq 69) and, on seed 5, a row whose remove
// was still on the way (M1). FIXED 2026-10-10 (DESIGN-SCALE stage 2, kernel/node.ts `resync`): a client's r=1
// carries `q`, the reply echoes it, the end is a reply at or above the resync's own q, what a stale reply shipped
// stays in the fold, a client in resync announces d = {}, and a client of a SCOPED feeder resyncs at every failover
// (so on a scoped cluster the failover digest IS the resync's ask and nothing can cross it). Seeds 1-12 are safe,
// M10 and M11 (resync-behind) green, a resync end seen on each of the four seeds, every spoke's screen equal to its
// kernel at the horizon. M1 reads no coverage off a spoke in resync (sim/monitors.ts `covers`): the re-download
// lawfully lands a lane's newest rows first. The planted violation for M10/M11 lives in sim/scale-probes.test.ts.
// A3 seed 6 WAS pinned here (2026-10-09): one attempt committed TWICE across an ownership move (the existing
// attempt-exactly-once monitor): n05's forwarded field remove of p58.f2 (cid 19) committed at n01 (t=1858.8, epoch 1,
// seq 35); 1.5 ms later the orphan cut took every n01 link down, before the commit's fan-out or its WACK left n01, so
// no other node held n01:35 and n05 never learnt it committed. n05 retried; n04, the owner by then, committed it
// again (epoch 4, seq 49). After the heal n01:35 reached n04 (t=3297) and both commits stood. The latch is not the
// gap: it feeds every taught record's attempt identity into the dedup window (kernel/scope.ts, `remember` in the
// ACQDONE fold), but no teacher ever held n01:35. This is the unscoped zombie's class (a commit stranded on a
// cut-off owner), seen here as a double commit, so its fix belongs with the zombie's (what a cut-off owner committed
// but never shipped), not with the latch's dedup tuples. A re-committed remove can erase a newer write. Found by
// this sweep. UNPINNED 2026-10-10 (DESIGN-SCALE stage 2): the seed is safe now, but NOT because the class is fixed
// — stage 2 moved every scoped trajectory (announce on change, no member digest), and on seed 6's new one the 1.5 ms
// window between the commit and the cut does not open (no attempt is stamped twice anywhere; every orphan sheds).
// The class stands, and so that it stays pinned in every battery the pin moves to A2 seed 9 (below).
// A2 seed 9: the same class on the demoted-owner shape (stage 0 saw it at FERO_SCOPED_SEEDS=12 on A2 seeds 9, 10
// and 12; stage 2's scan of A2/A3 seeds 1-12 sees exactly the same three, and A3 seed 10's partition not held where
// the ring assigns it): the joiner n90 commits n02's attempt 13 at epoch 1 seq 2, the demoted owner n04 commits it
// again at its old epoch (seq 39), and after the install both stand at n04. A re-committed remove can erase a newer
// write. Fix with the zombie's. The seed is LIVE (the two holders each ahead on their own lane teach each other —
// kernel/scoped.test.ts MUTUAL LATCH, the deadlock the digest's retirement uncovered on exactly this seed).
const KNOWN_UNSAFE: Record<string, Record<number, RegExp>> = {
  'A2-slow-owner-join': { 9: /attempt-exactly-once .*committed TWICE/ },
}

//! RESYNC_SEEDS — A11's four seeds of 1-12 whose failover lands on a feeder behind the spoke (the ones that were
// pinned unsafe above). They run in every battery on top of SEEDS, like the pinned seeds, so that on a scoped
// cluster a failover resync runs on every battery and M10/M11 see a resync end on every run (the non-vacuity row
// below). What they pin as a sweep is the two spoke fixes TOGETHER (the q end rule and the scoped-failover resync:
// reversing either alone leaves these seeds green, reversing both turns them red — the review of 2026-10-10); each
// fix alone is pinned in kernel/client.test.ts.
const RESYNC_SEEDS: Record<string, number[]> = { 'A11-spoke': [2, 5, 6, 10] }

//! ALWAYS — shapes a family must reach in every battery, whatever SEEDS is, because a pin below is vacuous without
// them. A7 seed 4 is n=2 R=1 (seeds 1-3 are all R=2): the one shape where the leaver alone holds rows, so the only
// one on which M9's leave-drain check can bite. With the drain removed it is the seed that goes red (checked
// 2026-10-10: base tree red=[leave-drain] on seed 4 alone of seeds 1-4; the branch green).
// A12 seeds 3, 5, 6, 8 and 11 are the shapes on which the spoke KEPT rows of partitions that moved off its feeder (6, 5, 1,
// 2 and 1 rows, measured 2026-10-12 on seeds 1-12; seeds 1 and 2 read 0 since V4-55 moved seed 2's join and leave). Since
// wave 6c (2026-10-21) a shed tells its spokes (FEED {x}, kernel/scope.ts evaluateSheds; the spoke drops the partition,
// node.ts #unfeed) and every seed of 1-12 reads 0: the five run in every battery so the 0 below is never vacuous.
const ALWAYS: Record<string, number[]> = {
  'A7-down-to-one': [4],
  'A12-spoke-handoff': [3, 5, 6, 8, 11],
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
  'A12-spoke-handoff': (e) => e.handoff === 1 && e.epoch >= 3 && e.feederAcquires > 0, // the join, the leave, and the spoke's feeder folded through the latch
  //! A13: the spoke's feeder folded a REPAIR (the delta leg) and a RE-ENTRY from an orphan (the whole-partition leg).
  // Every seed of 1-8 reaches both (repairs 7-41, re-entries 2-27, measured 2026-10-12). Mutation-checked on seeds 1 and
  // 2: with the re-entry forward taken out M12 names a row of a re-entered partition the spoke lacks on both; with the
  // delta forward taken out, a row of a repaired one on both. The answer's filter (feeds vs held) is NOT what this family
  // exercises — its spoke is synced all along — sighting 3 and the kernel tests cover that.
  'A13-spoke-repair': (e) => e.repairFolds > 0 && e.reentryFolds > 0,
}
//! SPOKED — the families with a spoke: M12 (spokeMirror) must have compared something on every one of them
const SPOKED = new Set(['A11-spoke', 'A12-spoke-handoff', 'A13-spoke-repair'])

for (const fam of FAMILIES) {
  test(`scoped sweep ${fam.name}: ${SEEDS} seeds${KNOWN_UNSAFE[fam.name] ? ', pinned unsafe ' + Object.keys(KNOWN_UNSAFE[fam.name]).join(',') : ''}${RESYNC_SEEDS[fam.name] ? ', resync seeds ' + RESYNC_SEEDS[fam.name].join(',') : ''}${ALWAYS[fam.name] ? ', always ' + ALWAYS[fam.name].join(',') : ''} — safe and live (lanes bounded), M8's tombstone half red today on every seed, compaction engaged, the chaos engaged`, () => {
    const unsafe: string[] = [], notLive: string[] = [], newlySafe: number[] = []
    let engaged = 0, cells = 0, advances = 0, resyncs = 0, resyncRows = 0, floorLanes = 0, markPairs = 0, rge2 = 0, spokeCells = 0, feederAcquires = 0, spokeStale = 0, lanePairs = 0, compactions = 0
    const pins = KNOWN_UNSAFE[fam.name] ?? {}
    const known = new Set(Object.keys(pins).map(Number))
    //! every pinned unsafe seed runs in every battery, whatever SEEDS is: a pin that never runs proves nothing, and
    // the newly-safe check below is the flip a fix must make; the ALWAYS shapes and the resync seeds run for the same reason
    const seeds = [...new Set([...Array.from({ length: SEEDS }, (_, i) => i + 1), ...known, ...(RESYNC_SEEDS[fam.name] ?? []), ...(ALWAYS[fam.name] ?? [])])]
    for (const seed of seeds) {
      const o = runFamily(fam, seed)
      if (o.unsafe.length) {
        if (!known.has(seed)) unsafe.push(`${o.shape}: ${o.unsafe.join(' | ')}`)
        else assert.match(o.unsafe.join(' | '), pins[seed], `${o.shape}: unsafe for the pinned reason`)
      }
      else if (known.has(seed)) newlySafe.push(seed)
      if (o.notLive.length) notLive.push(`${o.shape}: ${o.notLive.join(' | ')}`)
      assert.ok(o.redToday.includes('M8'), `${o.shape}: M8's tombstone half is red today on every scoped run with a remove (if green, stage 4 landed: flip the pin); its lane half is a law since stage 3 (notLive above)`)
      compactions += o.eng.compactions
      assert.ok(!o.red.has('leave-drain'), `${o.shape}: M9 red — a clean leaver took the only copy of a row with it (the drain, DESIGN-SCALE stage 1 (b), should have held it)`)
      if (ENGAGED[fam.name](o.eng)) engaged++
      cells += o.eng.cells; advances += o.eng.advances; resyncs += o.eng.resyncs; resyncRows += o.eng.resyncRows
      floorLanes += o.eng.floorLanes; markPairs += o.eng.markPairs; if (o.R >= 2) rge2++
      spokeCells += o.eng.spokeCells; feederAcquires += o.eng.feederAcquires ?? 0; spokeStale += o.eng.spokeStale ?? 0
      lanePairs += o.eng.lanePairs
    }
    assert.deepEqual(unsafe, [], 'UNSAFE: a monitor fired or M1\'s horizon form disagrees')
    assert.deepEqual(newlySafe, [], 'a schedule pinned unsafe is safe now: take it off KNOWN_UNSAFE, with the why')
    assert.deepEqual(notLive, [], 'not live at the horizon')
    assert.ok(engaged > 0, `${fam.name}: the chaos never engaged on seeds ${seeds.join(',')}`)
    if (fam.name === 'A11-spoke') {
      assert.ok(resyncs >= 4, `non-vacuity: M10 saw a spoke's resync end on each of the four resync seeds (${resyncs})`)
      assert.ok(resyncRows > 0, `non-vacuity: M11 checked ${resyncRows} rows the spoke held at a reset against its feeder`)
    }
    //! M12 (wave 6a): on every family with a spoke it compared cells; on the hand-off family the spoke's feeder folded
    // through the latch on some seed (the forward had records to carry), and the rows of partitions that moved off the
    // feeder are counted, not judged (eng.spokeStale — a STATUS gap, not this oracle's verdict)
    if (SPOKED.has(fam.name)) assert.ok(spokeCells > 0, `${fam.name}: non-vacuity — M12 compared ${spokeCells} spoke cells against the feeders' held subsets`)
    if (fam.name === 'A12-spoke-handoff') {
      assert.ok(feederAcquires > 0, `non-vacuity: the spoke's feeder acquired ${feederAcquires} partitions through the latch over the seeds`)
      //! CLOSED (wave 6c, 2026-10-21): the rows of a partition that moved OFF the spoke's feeder at the join (an orphan
      // there, then shed) used to stay on the spoke — nothing told it — until a failover's resync wiped them (spokeStale
      // read 6, 5, 1, 2 and 1 on the ALWAYS seeds 3, 5, 6, 8 and 11). Now the shed's FEED {x} makes the spoke drop the
      // partition with its feeder, and the count is 0 on every seed of 1-12. With the spoke's #unfeed off, seed 3 reads
      // 6 again (mutation-checked).
      assert.equal(spokeStale, 0, `the spoke kept ${spokeStale} rows of partitions that moved off its feeder (a shed tells its spokes since wave 6c)`)
    }
    assert.ok(cells > 0 && advances > 0, `${fam.name}: non-vacuity — M1 checked ${cells} cells, M5 ${advances} floor advances`)
    //! stage 3: compaction fired on this family (compactAt 16), so M2 frontier-sound judged real passes. This count is
    // ALSO the sweep's catch for "compaction switched off": at this workload (60-120 writes over 50-500 partitions) no
    // lane outgrows winners + 16 even with the pass off, so the lane law above stays green either way (checked
    // 2026-10-12 with scopedFrontier forced to 0: A1 seed 1 and A8 seed 1 read 0 passes, every lane within the bound);
    // where the lane law bites is P4 (sim/scale.perf.ts: 50,000 updates over 500 cells).
    assert.ok(compactions > 0, `${fam.name}: non-vacuity — ${compactions} compaction passes over the seeds (0 = compaction is off)`)
    //! the lane rule (wave 6b): the lane-unique monitor compared neighbouring pairs on every family (a lane holds each seq once)
    assert.ok(lanePairs > 0, `${fam.name}: non-vacuity — the lane rule compared ${lanePairs} neighbouring pairs across every node's lanes`)
    //! M7 compares nothing on an R=1 seed (one holder per partition): the row bites only where some seed drew R ≥ 2
    if (rge2 > 0) assert.ok(floorLanes > 0 && markPairs > 0, `${fam.name}: non-vacuity — M7 compared ${floorLanes} (partition, lane) floors and ${markPairs} (holder, co-holder, partition) marks over ${rge2} seed(s) at R ≥ 2`)
  })
}

//! the stage-2 mutations (DESIGN-SCALE §6 "a dropped dirty site (M7)"; the §7 stage-2 gate "harness green with the
// stage-2 mutations caught"). The review of 2026-10-10 found the harness green with the dirty mark dropped AND with the
// sweep off: M7's floor form heals through the re-admit, drain and install rounds. M7's knowledge form (marks-agree)
// is the catch. A8 is §6's family for this ("lost dirty announcements; the sweep must heal"); the two seeds are the
// family's R=3 and R=2 shapes (seed 3: n=5 R=3; seed 1: n=3 R=2). Red lines kept from the first run: seed 3 no-sweep
// "n02 knows n90's floor for 'p9' lane n01 as 4; n90 is at 30 — never heard"; seed 1 drop-dirty "n01 knows n02's
// floor for 'p319' lane n01 as 7; n02 is at 27 — never heard"; seed 1 no-sweep green (100 pairs compared).
test('stage-2 mutations: the sweep switched off is caught by M7\'s knowledge form on an R=3 shape (a co-holder pair has no owner to announce for it); the dirty site dropped is caught on an R=2 shape with the sweep off, where the sweep-off control alone is green — and neither is a safety hole', () => {
  const a8 = familyByName('A8-coholder-cut')
  const onlyM7 = (o: ReturnType<typeof runFamily>, what: string) => {
    assert.equal(o.eng.mutated, 1, `${o.shape}: the mutation engaged`)
    assert.deepEqual(o.unsafe, [], `${o.shape}: ${what} is a liveness hole, never a safety one`)
    assert.ok(o.red.has('marks-agree'), `${o.shape}: caught by marks-agree (red: ${[...o.red].join(',') || 'nothing'})`)
    assert.ok(o.notLive.length > 0 && o.notLive.every((s) => s.startsWith('M7 knowledge: ')), `${o.shape}: the only liveness red is stale knowledge — floors still agree, holders converge, exactly-R holds (${o.notLive.join(' | ')})`)
    assert.match(o.notLive[0], /knows .*'s floor for '.*' lane .* as \d+; .* is at \d+ — never heard/)
  }
  //! the sweep: seed 3 (R=3) green as is, red with aeFan 0
  const clean3 = runFamily(a8, 3)
  assert.equal(clean3.R, 3)
  assert.deepEqual([clean3.unsafe, clean3.notLive], [[], []], 'seed 3 is green as is')
  onlyM7(runFamily(a8, 3, 'no-sweep'), 'the sweep off')
  //! the dirty site: seed 1 (R=2) green as is, green with the sweep off alone (the control: every pair has its owner,
  // whose announcement converges it), red with the dirty mark dropped too
  const clean1 = runFamily(a8, 1)
  assert.equal(clean1.R, 2)
  assert.deepEqual([clean1.unsafe, clean1.notLive], [[], []], 'seed 1 is green as is')
  const ctrl = runFamily(a8, 1, 'no-sweep')
  assert.equal(ctrl.eng.mutated, 1)
  assert.deepEqual([ctrl.unsafe, ctrl.notLive], [[], []], 'the control: at R=2 the owner\'s announcement alone keeps every pair\'s knowledge current')
  assert.ok(ctrl.eng.markPairs > 0, `the control compared ${ctrl.eng.markPairs} pairs`)
  onlyM7(runFamily(a8, 1, 'drop-dirty'), 'the dirty site dropped')
})

//! the screen check (the review of the parked stale-reply fix, 2026-10-10) is part of runFamily's verdict, not only a
// function the probes call by hand: a row on a spoke's screen that its kernel does not hold makes the seed UNSAFE. The
// plant wraps A11's chaos and writes one key straight into the spoke's downstream object after the spoke exists; nothing
// in the kernel ever removes it, so the horizon check must name it. Red with the runFamily loop over spokes removed.
test('runFamily names a screen-only row on a spoke as UNSAFE ("screen: s1: …"): the horizon screen check is wired into the sweep\'s verdict', () => {
  const a11 = familyByName('A11-spoke')
  const planted = { ...a11, chaos: (c: Parameters<typeof a11.chaos>[0]) => { a11.chaos(c); c.sim.at(600, () => { c.sim.folds.get('s1')!.ghost = 1 }) } }
  const o = runFamily(planted, 1, 'none', 3000)
  assert.ok(o.red.has('screen'), `the screen check went red (red: ${[...o.red].join(',')})`)
  assert.ok(o.unsafe.some((u) => /^screen: s1: the object that reached the sink differs from the kernel's cells folded by depth/.test(u)), `UNSAFE names the spoke's screen: ${o.unsafe.join(' | ')}`)
  const clean = runFamily(a11, 1, 'none', 3000)
  assert.equal(clean.red.has('screen'), false, 'the same seed unplanted is green on the screen check')
})

//! the mutation runner's pinned catches: each schedule is green unmutated and red (M1, M3 or M6) with the mutation
const CAUGHT: [string, number, Mutation, string[]][] = [
  ['A1-zombie', 1, 'release-all', ['stamp-oracle', 'release-safety', 'census-truth']], // M6 at the release: the zombie still holds an older record
  ['A1-zombie', 1, 'version-only', ['stamp-oracle', 'release-safety', 'census-truth']], // G1: the zombie's write lands above the fence after the heal
  //! moved from A7 seed 2 to seed 5 with stage 3 (2026-10-12), and from seed 5 to seed 16 when the runner's lane filter
  // was fixed (2026-10-21). Both earlier catches were the RUNNER's bug, not the release's: `inject` matched the remove's
  // lane entry by the tombstone's stamp alone, and a field a row write swept carries the row's stamp (V4-18), so the
  // runner dropped the parent row's WINNING entry (M2 named it "still the WINNER" in every such run; M2 is not a
  // CATCHER). With the filter matching the remove's own entry (its stamp AND its cell), seeds 2 and 5 catch nothing:
  // every lane passed compactAt before the mutation fired, so the release leaves nothing older on a lane for a teach to
  // ship. Seed 16 (n=3 R=1) keeps an older write on a lane past the release: both catch (scanned A7 seeds 1-16; 16 is
  // the one that catches).
  ['A7-down-to-one', 16, 'release-all', ['stamp-oracle', 'release-safety']], // a re-joiner is taught the dead writes
  //! `drop-one` needs the dropping holder to TEACH the partition later WITH an older record still in its lane, so its
  // catch follows the trajectory. Stage 2 (2026-10-10) moved it twice (A6 seed 3 and A1 seed 4 traded places with the
  // targeted rounds and the member digest's retirement). Stage 3 (2026-10-12) took its bite away on most seeds: with
  // compactAt 16 the older write under the dropped remove is already compacted at that holder when the mutation fires
  // (mutateAt 300), so a later teach ships the live state without the remove but also without anything to resurrect
  // — A6 seed 3 and A7 seed 4 catch nothing now (scanned A1/A6/A7 seeds 1-8 and A2/A6/A7/A10 seeds 9-16: two seeds
  // catch). It is caught where an older record survives OUTSIDE the frontier: the healed zombie's stranded lane (A1
  // seed 8), and A4 seed 6 (n=3 R=3 durable, the restarts family). A2 seed 14 WAS the second pin: its
  // catch was the runner's own lane filter dropping a swept field's parent row (the A7 note above), and with the filter
  // fixed (2026-10-21) it catches nothing. Rescanned drop-one on seeds 1-16 of A1/A2/A6/A7/A10 and 1-8 of A3-A5, A8,
  // A9, A11-A13: A1 seed 8, A4 seed 6, A9 seed 8 and A12 seeds 1, 5, 7 catch.
  ['A1-zombie', 8, 'drop-one', ['stamp-oracle', 'release-safety', 'census-truth']], // the healed zombie is re-taught the partition without the remove
  ['A4-restarts', 6, 'drop-one', ['stamp-oracle', 'release-safety']], // the restarts family: an older record outlives the dropped remove
  //! moved from A11 seed 3 to seed 7 with stage 2 (the members' handshake timing changed the spoke's trajectory;
  // scanned over A11 seeds 1-12: 7 is the clean seed that catches it)
  ['A11-spoke', 7, 'version-only', ['release-safety']], // the spoke applies an old write under a released stamp
  //! NEW with stage 3 (2026-10-12): G1 bites across the families now. The released stamp makes the remove's entry a
  // loser, the next pass drops it, and the next teach (A3: a fresh acquirer) or spoke forward (A12: a re-entry ships
  // the whole partition in lane order) ships the older record without it. Before stage 3 neither family caught it.
  ['A3-orphan-cut', 5, 'version-only', ['stamp-oracle', 'release-safety', 'census-truth']], // the compacted remove never reaches the acquirer; the old write does
  ['A12-spoke-handoff', 1, 'version-only', ['release-safety']], // the re-entry forward ships the old field write, the remove is gone from the lane
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
    //! the runner weakens a RELEASE, never anything else: it drops a remove's own entry, never a live cell's winner
    // (a swept field's tombstone carries its parent row's stamp, V4-18; matching by stamp alone dropped the parent)
    const winner = o.unsafe.filter((u) => /still the WINNER/.test(u))
    assert.deepEqual(winner, [], `${o.shape}: the mutation runner dropped a winning entry`)
  }
})
