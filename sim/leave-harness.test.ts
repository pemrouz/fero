//! The adversarial leave harness, pinned on today's kernel (DESIGN-LEAVE §9 step 2 and §10, 2026-10-10). The
// generators are in sim/leave-harness.ts; this file runs each family over its range and pins two things apart:
//   SAFETY  — ASSERTED on every schedule: no monitor fired (one-view-per-epoch above all) and no two nodes ended
//             WRITABLE in different views at a quiet point. The base is safe on every family here but three, which
//             are holes of today's kernel and are pinned RED as the exact seeds or end state they split on, so a fix
//             shows as a moved pin: evictTwo (two suspects evicted at once, the third voter cut on its grant),
//             evictTwoB (the same with the stale voter granting a never-voted member's higher ballot), and keptBallot
//             (a ballot kept across an install commits two members apart from the view it was kept across, at n=4).
//   LIVENESS — COUNTED, pinned as exact sets in both directions (a schedule the kernel used to heal that wedges now
//             is a regression; one that heals where it used to wedge means the pin is stale: update it on purpose,
//             with the why). Today's kernel is not live on every schedule (I-20), so the exact sets are the FLOOR.
//             Safety and liveness are never asserted in one list: a liveness move must read apart from a split.
// Teeth, measured on 2026-10-10 by putting the parked branch's kernel/membership.ts over a scratch copy of this tree
// (docs/DESIGN-LEAVE.md §10.8): the round-0 kernel (851796b) fails `twoLeavers` (two views at epoch 2, H1); the
// review-fix kernel (915d027) fails the two n=3 named shapes (not live, H3); the round-1 kernel (02f65ed) fails
// the seed-157 shape (0 of 10, H7); rounds 1 and 3 fail `evictsplit`, `joinsplit`, the isolate grid (11 and 9 of
// 108 split) and the seeded isolate family (12 and 8 of 100) — H11; round 3 wedges the three H9_SEEDS the base heals
// (H9), and four more crash schedules than the base in the default grid (#9, #11, #25, #27) and 24 more in the full
// one, all of them the n=3 crash twin (H12); the round-3 kernel also splits `pledgeTwo` on 5 of 5 (its gate counts a
// read-only leaver's link, the 2026-10-10 review's blocker — with the cut at 0 ms; the first version's 3 ms cut let
// the VOTEs land and was green there, the second review). The base's own holes are `evictTwo`, `evictTwoB` and
// `keptBallot`, pinned red. The candidate rule of §10.9 step 2 (a vote above my view: gate closed, lead nothing,
// grant nothing new) turns `flapDuringBallot` and `proposerCrash` red — every live member read-only for good where
// the base heals — which is the release question (§10.2). Bounded: about 30 s at low priority on the loaded WSL2
// box, half that idle; FERO_LEAVE_FULL=1 runs the full crash grid (576 cases, three restart delays, two seeds) and
// 100 seeded isolate schedules instead of 50.
import { test } from 'node:test'
import assert from 'node:assert'
import { evictsplit, joinsplit, twoLeavers, pledgeTwo, evictTwo, evictTwoB, keptBallot, flapDuringBallot, proposerCrash, scheduleR, runR, shapeR, NAMED_R, namedR, H9_SEEDS, GRID_I, scheduleI, runI, shapeI, gridC, runC, shapeC, exploreQuiet } from './leave-harness.ts'
import type { OutcomeI } from './leave-harness.ts'
import { unsafe, split } from './leave-sweep.ts'
import { Mesh, quietSplit } from './mesh.ts'
import { Sim } from './exec.ts'
import { cluster } from './harness.ts'
import { JK } from '../kernel/journal.ts'

const FULL = process.env.FERO_LEAVE_FULL === '1'

//! pinDiff — the sweep's rule (sim/leave-sweep.test.ts) as lines: the not-live (or not-settled) set against the
// pinned one in both directions, each difference its own line, so a test can gather it with its other teeth and
// every message prints. pinExact asserts it alone.
const pinDiff = (label: string, actual: number[], known: Set<number>, shapes: Map<number, string>) => [
  ...actual.filter((s) => !known.has(s)).map((s) => `${label}: a schedule the kernel used to heal is not live now — a liveness regression, or update the pin on purpose: ${shapes.get(s)}`),
  ...[...known].filter((s) => !actual.includes(s)).map((s) => `${label}: a schedule known to wedge is live now — take it off the pin: ${s}`),
]
const pinExact = (label: string, actual: number[], known: Set<number>, shapes: Map<number, string>) => assert.deepEqual(pinDiff(label, actual, known, shapes), [])

//! the two round-3 schedules run ONCE (about 4 s together) and are read by two tests: the safety test asserts, the
// liveness test pins
let outcomesEJ: Record<'evictsplit' | 'joinsplit', OutcomeI[]> | null = null
const evictAndJoin = () => (outcomesEJ ??= { evictsplit: [1, 2, 3, 4, 5].map((s) => evictsplit(s)), joinsplit: [1, 2, 3, 4, 5].map((s) => joinsplit(s)) })

test('leave harness, safety pins: evictsplit and joinsplit (the round-3 report\'s two schedules) — safe on seeds 1..5, n01 is never writable while cut off from every member; twoLeavers (the first review\'s n=4 schedule) — safe on seeds 1..10', () => {
  const bad: string[] = []
  for (const [name, outs] of Object.entries(evictAndJoin())) outs.forEach((o, i) => {
    if (o.problems.length) bad.push(`${name} ${i + 1}: ${o.problems.join('; ')}`)
    if (o.proposerWritable) bad.push(`${name} ${i + 1}: n01 writable while cut off from every member`)
  })
  for (let seed = 1; seed <= 10; seed++) { const ps = twoLeavers(seed); if (ps.length) bad.push(`twoLeavers ${seed}: ${ps.join('; ')}`) }
  assert.deepEqual(bad, [], 'UNSAFE, or n01 committed on votes it never received live')
})

//! evictsplit and joinsplit on today's kernel: the far side settles (one view without n01, writable) on 5 of 5 each,
// because the restored n03 leads it (evictsplit) or n02 does (joinsplit) while a vote above the old view is in play
// — the rule of DESIGN-LEAVE §10.9 step 2 moves BOTH pins to all five not settled (measured on the scratch three-part
// kernel: 0 of 10), and the page lists them among the pins that move. Liveness, so pinned here as counted sets,
// apart from the safety lines above.
const KNOWN_NOT_SETTLED_EVICTSPLIT = new Set<number>([])
const KNOWN_NOT_SETTLED_JOINSPLIT = new Set<number>([])

test('leave harness, liveness pins: evictsplit and joinsplit — the far side settles without n01 on exactly the seeds the pins say (all five today)', () => {
  const o = evictAndJoin()
  const teeth: string[] = []
  for (const [name, known] of [['evictsplit', KNOWN_NOT_SETTLED_EVICTSPLIT], ['joinsplit', KNOWN_NOT_SETTLED_JOINSPLIT]] as const) {
    const notSettled: number[] = [], shapes = new Map<number, string>()
    o[name].forEach((x, i) => { shapes.set(i + 1, `${name} ${i + 1}: the far side did not settle`); if (!x.settled) notSettled.push(i + 1) })
    teeth.push(...pinDiff(name, notSettled, known, shapes))
  }
  assert.deepEqual(teeth, [])
})

//! pledgeTwo on today's kernel: no knock is a vote, so n01 (one stayer beside it, three members cut off the instant it
// has read both knocks) commits nothing and is read-only; the three on the far side re-form without n01 and n02. A
// kernel that commits "the view minus the two leavers" on the knocks (the restricted pledge of DESIGN-LEAVE §10.3)
// splits here: n01@2{n01,n02,n03} beside n03@1 with the leavers' links, then two views at epoch 3 — the review's
// blocker, and the family the isolate grid cannot draw (it cuts n01 from everyone). Measured on the round-3 kernel
// (6de8eee) with the cut at 0 ms: 5 of 5 split (46 to 3,553 one-view-per-epoch violations, `n01@3{n01,n02}` beside
// `n03@3{n03,n04,n05}` or @4 at the horizon); with the first version's 3 ms cut, 0 of 5 — the VOTEs in flight landed.
// SAFETY is asserted. The far side SETTLING is liveness and is pinned as a counted set, like every other family: on
// today's kernel it settles on all five, but only because n03 leads while holding a vote at 2 above its view 1 — the
// rule of §10.9 step 2 would close that gate (and the restored leavers' too, both hold votes at 2), so under it this
// pin is EXPECTED to move to all five not settled, with the why in the commit.
const KNOWN_NOT_SETTLED_PLEDGE_TWO = new Set<number>([])

test('leave harness, pledgeTwo: two leavers knock to n01, then n01 keeps one stayer and the other stayer keeps both leavers (the 2026-10-10 review\'s probe, the cut at 0 ms) — SAFE on seeds 1..5, n01 never writable; the not-settled set is exactly the pinned one', () => {
  const bad: string[] = [], notSettled: number[] = [], shapes = new Map<number, string>()
  for (let seed = 1; seed <= 5; seed++) {
    const o = pledgeTwo(seed)
    shapes.set(seed, `pledgeTwo ${seed}: ${o.problems.join('; ')}`)
    if (o.problems.length) bad.push(shapes.get(seed)!)
    if (o.proposerWritable) bad.push(`pledgeTwo ${seed}: n01 writable on two knocks and one stayer`)
    if (!o.settled) notSettled.push(seed)
  }
  assert.deepEqual(bad, [], 'UNSAFE, or n01 committed on votes it never received live')
  pinExact('pledgeTwo', notSettled, KNOWN_NOT_SETTLED_PLEDGE_TWO, shapes)
})

//! rebirth on today's kernel: the seeds it is NOT live on inside 1..100 (20 of 100): pairs cut apart inside the leave
// window, a leaver's knock that dies with a cut and is never answered, three leavers at n=4 with the lowest among them
// under a cut. Pinned exactly. Above the range, H9_SEEDS are the three the base heals and the parked branch wedges:
// pinned live. The knock window (DESIGN-LEAVE §10.7, 2026-10-10) took 61 and 72 off this pin, 22 → 20: in both a
// leaver cut from the proposer for 300 ms kept an admitted link to another member and knocked on, where before it
// gave up at the fifth tick; the cut healed inside the 16-tick window and the knock reached the lowest live member
// (61: n=5, n02, n04 and n05 stop, n03-n01 and n04-n01 cut; 72: n=4, n01, n02 and n04 stop, n01-n04 cut 300 ms and
// n02-n01 600 ms). No other seed moved.
const KNOWN_NOT_LIVE_R = new Set<number>([8, 9, 19, 25, 26, 31, 32, 33, 40, 41, 46, 47, 49, 50, 60, 63, 64, 82, 84, 98])

test('leave harness, rebirth: 100 seeded schedules of cuts and heals between pairs with leavers reborn as fresh identities (the round-2 report\'s sweep2) — SAFE on every one; the not-live set is exactly the pinned one; the H9 seeds 306, 744 and 804 heal; the named shapes heal (seed 157 under 10 sim seeds, the n=3 two-stop pair once each)', () => {
  const unsafeOnes: string[] = [], notLive: number[] = [], shapes = new Map<number, string>()
  for (let seed = 1; seed <= 100; seed++) {
    const s = scheduleR(seed); const ps = runR(s)
    shapes.set(seed, `${shapeR(s)}: ${ps.join('; ')}`)
    if (unsafe(ps)) unsafeOnes.push(shapes.get(seed)!)
    else if (ps.length) notLive.push(seed)
  }
  assert.deepEqual(unsafeOnes, [], 'UNSAFE: a monitor fired, or two nodes ended writable in different views')
  //! the three liveness teeth in ONE list, so each fires on its own: the named shapes (H3 and H7), the H9 seeds, and
  // the exact pin. Asserted one after another, the first message hid the rest — on the review-fix kernel the H9 line
  // fired while the n=3 shapes were the hole (H3), on round 1 the pin fired while seed 157 was (H7); the third review
  const teeth: string[] = []
  for (const name of Object.keys(NAMED_R)) for (let seed = 1; seed <= (name === 'r2-157' ? 10 : 1); seed++) { const ps = runR(namedR(name, seed)); if (ps.length) teeth.push(`a named shape the base heals did not heal — ${name} under sim seed ${seed}: ${ps.join('; ')}`) }
  for (const seed of H9_SEEDS) { const s = scheduleR(seed); const ps = runR(s); if (ps.length) teeth.push(`an H9 seed the base heals did not heal (the parked branch wedges these) — ${shapeR(s)}: ${ps.join('; ')}`) }
  teeth.push(...pinDiff('rebirth', notLive, KNOWN_NOT_LIVE_R, shapes))
  assert.deepEqual(teeth, [])
})

//! isolate on today's kernel: the grid's far side settles (one view without n01, writable) on 84 of 108; on the other
// 24 — every n=3 schedule whose cut comes 10 or 30 ms after the stops (#6-#17 one leaver, #24-#35 two) — the far side
// is a stayer alone or a pair cut from a leaver whose vote it needs: the I-20 class. n01 is writable on none (a
// proposer cut from every member can commit nothing). Pinned as an exact index set. The seeded family settles on 42
// of 50.
const KNOWN_NOT_SETTLED_GRID_I = new Set<number>([6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35])
const KNOWN_NOT_SETTLED_I = new Set<number>([4, 11, 13, 21, 29, 35, 36, 39, ...(FULL ? [56, 59, 60, 61, 68, 69, 74, 79, 80, 90, 93, 97, 99] : [])])

test('leave harness, isolate grid: the 108 schedules the round-3 report counted — the proposer cut off 5/10/30 ms after one or two stops, the leavers back from their dirs 0.3/1.5/5 s later beside a stale stayer — SAFE on every one, n01 writable on none, the not-settled set is exactly the pinned 24', () => {
  const unsafeOnes: string[] = [], writable: string[] = [], notSettled: number[] = [], shapes = new Map<number, string>()
  GRID_I.forEach((s, i) => {
    const o = runI(s)
    shapes.set(i, `#${i} ${shapeI(s)}: ${o.problems.join('; ')}`)
    if (unsafe(o.problems)) unsafeOnes.push(shapes.get(i)!)
    if (o.proposerWritable) writable.push(shapes.get(i)!)
    if (!o.settled) notSettled.push(i)
  })
  assert.deepEqual(unsafeOnes, [], 'UNSAFE: a monitor fired, or two nodes ended writable in different views')
  assert.deepEqual(writable, [], 'n01 writable while cut off from every member: a commit on votes it never received live')
  pinExact('isolate grid', notSettled, KNOWN_NOT_SETTLED_GRID_I, shapes)
})

test('leave harness, isolate seeded: 50 schedules (100 with FERO_LEAVE_FULL) — n 3..5, one to n-2 non-lowest leavers, slow links, a joiner on the proposer\'s side one time in three — SAFE on every one; the not-settled set is exactly the pinned one', () => {
  const N = FULL ? 100 : 50
  const unsafeOnes: string[] = [], notSettled: number[] = [], shapes = new Map<number, string>()
  for (let seed = 1; seed <= N; seed++) {
    const s = scheduleI(seed); const o = runI(s)
    shapes.set(seed, `${shapeI(s)}: ${o.problems.join('; ')}`)
    if (unsafe(o.problems)) unsafeOnes.push(shapes.get(seed)!)
    else if (!o.settled) notSettled.push(seed)
  }
  assert.deepEqual(unsafeOnes, [], 'UNSAFE: a monitor fired, or two nodes ended writable in different views')
  pinExact('isolate seeded', notSettled, KNOWN_NOT_SETTLED_I, shapes)
})

//! crash on today's kernel: the default grid (96: the leavers back after 0.4 s, sim seed 1) wedges on 10 — every one
// a stayer that crashes AFTER the leaves (+20 or +100 ms) and never comes back: at n=3 the one stayer left (or the two
// restored leavers) sits in a minority of the old view; at n=4 the same with two leavers. The crash-at-two class
// (DESIGN-LEAVE §7). The full grid (576) wedges on 60, the same class. Both pinned exactly, as index sets.
const KNOWN_NOT_LIVE_C = new Set<number>(FULL
  ? [30, 31, 32, 33, 34, 35, 42, 43, 44, 45, 46, 47, 78, 79, 80, 81, 82, 83, 90, 91, 92, 93, 94, 95, 126, 127, 128, 129, 130, 131, 138, 139, 140, 141, 142, 143, 174, 175, 176, 177, 178, 179, 186, 187, 188, 189, 190, 191, 282, 283, 284, 285, 286, 287, 378, 379, 380, 381, 382, 383]
  : [5, 7, 13, 15, 21, 23, 29, 31, 47, 63])

test('leave harness, crash: a stayer crashes 200 ms before, at, 20 or 100 ms after one or two clean stops, comes back from its dir after 2 s or never, the leavers restarted from their dirs (the round-3 report\'s crash2) — SAFE on every one; the not-live set is exactly the pinned one', () => {
  const grid = FULL ? gridC() : gridC([400], [1])
  const unsafeOnes: string[] = [], notLive: number[] = [], shapes = new Map<number, string>()
  grid.forEach((s, i) => {
    const ps = runC(s)
    shapes.set(i, `#${i} ${shapeC(s)}: ${ps.join('; ')}`)
    if (unsafe(ps)) unsafeOnes.push(shapes.get(i)!)
    else if (ps.length) notLive.push(i)
  })
  assert.deepEqual(unsafeOnes, [], 'UNSAFE: a monitor fired, or two nodes ended writable in different views')
  pinExact('crash', notLive, KNOWN_NOT_LIVE_C, shapes)
})

//! the check itself, pinned twice. By hand: two members each writable alone in a solo view of its own is the split
// the one-view-per-epoch recorder cannot see (the epochs are equal, the members differ, nothing was installed twice at
// one epoch); one solo view is not. And from a RUN on real Nodes (the 2026-10-10 review's probe): evictTwo's shape
// built move by move — five formed, {aa,bb} cut from {dd,ee} and the chains given up, aa evicts both at 2 on bb's
// and cc's grants, and cc is cut before the VIEW reaches it — ends with aa and bb writable at 2 beside cc, dd and ee
// writable at 1, one view per epoch intact. No random family ever made it fire on today's kernel; this is its teeth.
// The run witness is the base's own hole: a kernel that closes evictTwo (cc's gate shuts on its vote at 2 above view
// 1) turns this line red too, and the rule of DESIGN-LEAVE §10.9 step 2 re-records it with the why — the hand pins
// above and below it do not depend on the kernel's ballot rules.
test('leave harness, the quiet-point check: two nodes writable in different views are named; one writable node is not; a two-evictee ballot with the third voter cut before its VIEW is named with no second view at any epoch', () => {
  const m = new Mesh()
  const aa = m.add('aa'), bb = m.add('bb')
  aa.membership.install(aa, { epoch: 1, members: [['aa', 'sim:aa']] })
  assert.equal(quietSplit(m, 0), null)
  bb.membership.install(bb, { epoch: 1, members: [['bb', 'sim:bb']] })
  assert.match(quietSplit(m, 0) ?? '', /aa@1\{aa\} bb@1\{bb\}/)
  //! the run: evictTwo on the mesh
  const five = Mesh.formed(['aa', 'bb', 'cc', 'dd', 'ee'])
  for (const a of ['aa', 'bb']) for (const b of ['dd', 'ee']) five.cut(a, b)
  for (let i = 0; i < 3; i++) five.tick('aa') // suspect first, then exhaust the chains (V4-20)
  for (const b of ['dd', 'ee']) five.giveUp('aa', b)
  five.tick('aa')
  const proposed = five.nodes.get('aa')!.journal.read().filter((e) => e.kind === JK.propose).map((e) => [e.a, e.b])
  assert.deepEqual(proposed, [[2, 3]], 'aa evicted dd and ee in one ballot at 2')
  for (const x of ['bb', 'cc']) { assert.equal(five.deliver('aa', x), 'PROPOSE'); assert.equal(five.deliver(x, 'aa'), 'VOTE') }
  assert.equal(five.nodes.get('aa')!.epoch, 2, 'aa committed {aa,bb,cc}@2 on its own vote, bb and cc')
  five.cut('aa', 'cc'); five.cut('bb', 'cc') // the VIEW to cc dies on the cut; cc keeps view 1 and a vote at 2
  assert.deepEqual(five.splits, [], 'one view per epoch holds: the recorder sees nothing')
  assert.match(quietSplit(five) ?? '', /aa@2\{aa,bb,cc\} bb@2\{aa,bb,cc\} cc@1\{aa,bb,cc,dd,ee\} dd@1\{aa,bb,cc,dd,ee\} ee@1\{aa,bb,cc,dd,ee\}/)
  //! the sweep's split() by hand, the same rule on Sim nodes: a node at epoch 0 is open genesis — writable, but IN no
  // view — so it is not one side of a split; a second solo view at epoch 1 is (the mutation "drop `x.epoch > 0`"
  // names n02@0{} beside n01@1{n01} and turns this red)
  const sim = new Sim(1)
  const [n01, n02] = cluster(sim, 2, { heartbeatMs: 50 })
  n01.membership.install(n01, { epoch: 1, members: [['n01', 'sim:n01']] })
  assert.equal(n02.membership.gate(n02).open, true, 'open genesis is writable')
  assert.equal(split(sim), null, 'an epoch-0 writable node beside a writable view is not a split')
  n02.membership.install(n02, { epoch: 1, members: [['n02', 'sim:n02']] })
  assert.match(split(sim) ?? '', /SPLIT: writable in different views: n01@1\{n01\} n02@1\{n02\}/)
})

//! evictTwo on today's kernel: a hole, counted (DESIGN-LEAVE §10.2). A ballot that evicts TWO suspects at once at n=5
// shrinks the view to three; a voter cut (or crashed) right after its grant never learns the view it consented to,
// stays at the old view with the two "suspects" as a reachable majority of it, and as their lowest live member leads
// them into a view of its own — at the SAME epoch the proposer's side reaches next, so the sim's one-view-per-epoch
// monitor fires, and both sides are writable. Seeds 1, 2, 4 and 5 of 5 in both variants (seed 3 misses the timing);
// the one-evictee control never splits (the arithmetic forbids it). A kernel that closes the hole empties these
// lists: re-record them with the why, and move the STATUS line.
// evictTwoB is the same hole with the stale voter NOT the far side's lowest member: a node that never voted leads the
// far side and the stale voter GRANTS its higher ballot (seed 3 misses the timing, as in evictTwo). It is the schedule
// that a rule of "a vote above my view closes my gate and I lead nothing" does NOT close (measured on a scratch
// kernel: evictTwo 0 of 10, evictTwoB still 1, 2, 4, 5), and that one grant clause does (0 of 5) — DESIGN-LEAVE
// §10.2. A kernel that turns evictTwo green and leaves this red has closed half the hole.
const SPLITS_EVICT_TWO = { cut: [1, 2, 4, 5], crash: [1, 2, 4, 5] }
const SPLITS_EVICT_TWO_B = [1, 2, 4, 5]

test('leave harness, evictTwo: two suspects evicted at once at n=5 with the third voter cut or crashed on its grant — today\'s kernel commits two views at one epoch and ends writable on both sides on exactly the pinned seeds; one evictee never splits; evictTwoB (the stale voter is not the far side\'s lowest, so it GRANTS a never-voted member\'s higher ballot) splits on exactly the pinned seeds too', () => {
  for (const how of ['cut', 'crash'] as const) {
    const bad: number[] = [], detail: string[] = []
    for (let seed = 1; seed <= 5; seed++) { const ps = evictTwo(seed, how, 2); if (ps.length) { bad.push(seed); detail.push(`${seed}: ${ps.join('; ')}`) } }
    assert.deepEqual(bad, SPLITS_EVICT_TWO[how], `${how}, two evictees: the split set moved — a kernel change closed (or widened) the hole; re-record with the why\n${detail.join('\n')}`)
    const control: string[] = []
    for (let seed = 1; seed <= 5; seed++) { const ps = evictTwo(seed, how, 1); if (ps.length) control.push(`${seed}: ${ps.join('; ')}`) }
    assert.deepEqual(control, [], `${how}, one evictee: the new view's majority and the old view's must share a voter`)
  }
  const badB: number[] = [], detailB: string[] = []
  for (let seed = 1; seed <= 5; seed++) { const ps = evictTwoB(seed); if (ps.length) { badB.push(seed); detailB.push(`${seed}: ${ps.join('; ')}`) } }
  assert.deepEqual(badB, SPLITS_EVICT_TWO_B, `evictTwoB: the split set moved — a kernel change closed (or widened) the hole's grant half; re-record with the why\n${detailB.join('\n')}`)
})

//! keptBallot on today's kernel: a hole, pinned as the end state (DESIGN-LEAVE §10.2 (ii); the third 2026-10-10
// review's probe). The ballot aa keeps across its install of view 2 is over view 1 and commits `{aa,cc,dd}`@3 TWO
// members apart from view 2 (`{bb,cc,dd}`), so the count that protects a one-member change does not hold: at the
// quiet point aa and dd write at 3 beside bb and cc at 2 (one view per epoch intact — the recorder sees nothing), and
// once the chains give up bb evicts dd and aa evicts cc, two views at epoch 4, both writable, the recorder firing
// twice. The page and STATUS called this shape undrawn until the third review drew it. One deterministic schedule,
// no seed. Measured on the scratch kernels (§10.2): the two-part rule (gate closed, lead nothing) leaves the quiet
// point clean but STILL splits at epoch 4 — cc, holding a vote at 3 above view 2, grants bb's `{bb,cc}`@4; the
// three-part rule (the grant clause too) ends with no split anywhere and bb and cc read-only for good. A kernel that
// closes it moves this pin: re-record with the why, and move the STATUS line.
const KEPT_BALLOT_QUIET = 'writable in different views: aa@3{aa,cc,dd} bb@2{bb,cc,dd} cc@2{bb,cc,dd} dd@3{aa,cc,dd}'
const KEPT_BALLOT_SPLITS = ['epoch 4: {aa,dd} vs {bb,cc} (at bb)', 'epoch 4: {aa,dd} vs {bb,cc} (at cc)']
const KEPT_BALLOT_END = 'aa@4{aa,dd}W bb@4{bb,cc}W cc@4{bb,cc}W dd@4{aa,dd}W'

test('leave harness, keptBallot: at n=4 the loser of a duel escalates over view 1, installs view 2 evicted, keeps the ballot and commits {aa,cc,dd}@3 on two granters at view 2 — today\'s kernel is writable in two views at the quiet point and commits two views at epoch 4 once the chains give up, exactly as pinned', () => {
  const o = keptBallot()
  assert.deepEqual(o.shape, [], 'not the shape the page describes: the kernel moved a step of it')
  //! the three pins in ONE list, so a kernel that moves one of them shows the others too (the two-part rule keeps the
  // epoch-4 split and clears the quiet point; the three-part rule clears both)
  const moved: string[] = []
  if (o.quiet !== KEPT_BALLOT_QUIET) moved.push(`the quiet point moved: ${o.quiet}`)
  if (o.splits.join('|') !== KEPT_BALLOT_SPLITS.join('|')) moved.push(`the epoch-4 split moved: ${o.splits.join('; ') || 'none'}`)
  if (o.end !== KEPT_BALLOT_END) moved.push(`the end state moved: ${o.end}`)
  assert.deepEqual(moved, [], 'a kernel change closed (or widened) the kept-ballot hole; re-record with the why')
})

//! a FAILED ballot in a healthy cluster (DESIGN-LEAVE §10.2, the release): the flap and the proposer crash. Today's
// kernel heals both — every live member writable, no split — and the vote the granters hold above their view is
// never read. The candidate rule of §10.9 step 2 reads it: measured on the scratch kernels, the TWO-part rule (gate
// closed, lead nothing) and the THREE-part rule alike leave all five read-only for good after the flap (bb, cc, dd
// `stale-vote`; aa and ee `minority`, because a stayer's gate skips the three) and all four after the crash (bb and
// cc `stale-vote`, dd and ee `minority`), with no proposer left to release the vote. So the release is needed by the
// gate and lead parts, not only by the grant. Liveness, pinned as the exact read-only set (empty today): a rule
// that moves it must say how the vote is released, and re-record with the why. The three shapes' liveness teeth
// are gathered in ONE list, as the rebirth and keptBallot tests do: asserted one after another, the flap's message
// hid the crash's on both scratch kernels, where all three are red together (the third re-check).
const KNOWN_READ_ONLY_FLAP: string[] = []
const KNOWN_READ_ONLY_CRASH: Record<'open' | 'committed', string[]> = { open: [], committed: [] }
const CRASH_END = 'bb@3{bb,cc,dd,ee}W cc@3{bb,cc,dd,ee}W dd@3{bb,cc,dd,ee}W ee@3{bb,cc,dd,ee}W'

test('leave harness, a failed ballot in a healthy cluster: one member flaps during an eviction ballot and the proposer abandons it; the proposer crashes for good mid-ballot (open, or committed with its VIEW unsent) — SAFE, and on today\'s kernel every live member is writable again (the read-only set is exactly the pinned one, empty)', () => {
  const runs = [['flapDuringBallot', flapDuringBallot()] as const, ...(['open', 'committed'] as const).map((v) => [`proposerCrash ${v}`, proposerCrash(v)] as const)]
  //! safety first, all three shapes in one list, apart from the liveness teeth below
  const unsafeOnes = runs.flatMap(([name, o]) => [...o.shape, ...o.splits, ...(o.quiet ? [o.quiet] : [])].map((p) => `${name}: ${p}`))
  assert.deepEqual(unsafeOnes, [], 'not the shape, or UNSAFE')
  //! the liveness teeth, one list: the read-only set and the end state of every shape
  const teeth: string[] = []
  const [, f] = runs[0]
  if (f.readOnly.join(' ') !== KNOWN_READ_ONLY_FLAP.join(' ')) teeth.push(`flapDuringBallot: the read-only set moved — a gate rule on a vote above the view needs its release; re-record with the why: ${f.end}`)
  if (!/^aa@1\{aa,bb,cc,dd,ee\}W /.test(f.end)) teeth.push(`flapDuringBallot: the abandoned ballot committed something — view 1 should stand: ${f.end}`)
  for (const variant of ['open', 'committed'] as const) {
    const [, c] = runs[variant === 'open' ? 1 : 2]
    if (c.readOnly.join(' ') !== KNOWN_READ_ONLY_CRASH[variant].join(' ')) teeth.push(`proposerCrash ${variant}: the read-only set moved — a gate rule on a vote above the view needs a release that works with the proposer dead; re-record with the why: ${c.end}`)
    if (c.end !== CRASH_END) teeth.push(`proposerCrash ${variant}: the four did not re-form without aa at 3: ${c.end}`)
  }
  assert.deepEqual(teeth, [])
})

//! the explorer's range here starts ABOVE the 1..2000 sim/explore.test.ts pins, so every seed adds coverage (the
// one-view-per-epoch recorder on new schedules, and the quiet check on all of them) instead of re-running a pinned one
test('leave harness, explorer: 300 seeded random schedules (2001..2300) over real Nodes with the quiet-point split check — never two views at one epoch, never two nodes writable in different views once every frame has landed', () => {
  const bad: string[] = []
  for (let seed = 2001; seed <= 2300; seed++) { const o = exploreQuiet(seed); if (o.bad) bad.push(`seed ${seed} n=${o.n}: ${o.bad}`) }
  assert.deepEqual(bad, [])
})
