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
// the base heals — which is the release question (§10.2). The five release shapes (§10.10: releasedEarly,
// proposerDeadStale, retrySameEpoch, twoFailedBallots, lateView) pin what that rule's release must keep: red today
// where the base splits (releasedEarly, lateView's window), live today everywhere else. The second review of §10.10
// added five more (2026-10-10): lateAsk (the held member's heartbeat is late: a stayer that forgets the ask on a
// clock counts it again — red today as the quiet-point witness is), keptBallotReversed (the kept ballot granted one
// apart and two apart after the install — red today), and three liveness shapes pinned as end states: allHeld (every
// live member holds the dead proposer's view), genesisProposerDies (the first proposer dies at epoch 0), and
// proposerAndGranterDie (the rule's cost with no cut among the living). The third review added four (2026-10-10):
// clientAsk (a client's HELLO and PULL naming a hold teach nothing — live today, I-23), freshLink (a held member's
// link flaps: the stayer must not count the fresh link before it knows the holds — red today as the witness is),
// genesisProposerAndGranterDie (the genesis hold's cost: one survivor with memory beside a newcomer or a reborn pair —
// live today) and genesisSplit (today's kernel commits two views at one epoch at genesis, hostless — red today).
// The fourth review added four and a record (2026-10-10), one pin per kernel line of the rule's wire: clientGenesis
// (a client's word at epoch 0 — live today) and serverAsk (a non-member server's word — live today), the two halves
// of I-23's fix that clientAsk catches only together; helloHold (a hold a stayer learned from a HELLO alone must be
// taken back when it ends — live today, the rule's own liveness gap at epoch 0); freshLinkSim (freshLink on REAL
// HELLOs in the Sim, since the mesh writes its own — red today as evictTwo is); and genesisProposerAndGranterDie now
// records every node's proposal list and bb's vote, so a rule that re-proposes while frozen is pinned to the SAME epoch.
// Bounded: about 30 s at low priority on the loaded WSL2
// box, half that idle; FERO_LEAVE_FULL=1 runs the full crash grid (576 cases, three restart delays, two seeds) and
// 100 seeded isolate schedules instead of 50.
import { test } from 'node:test'
import assert from 'node:assert'
import { evictsplit, joinsplit, twoLeavers, pledgeTwo, evictTwo, evictTwoB, keptBallot, flapDuringBallot, proposerCrash, releasedEarly, proposerDeadStale, retrySameEpoch, twoFailedBallots, lateView, lateAsk, allHeld, genesisProposerDies, proposerAndGranterDie, keptBallotReversed, clientAsk, freshLink, genesisProposerAndGranterDie, genesisSplit, clientGenesis, serverAsk, helloHold, freshLinkSim, readOnlyOf, scheduleR, runR, shapeR, NAMED_R, namedR, H9_SEEDS, GRID_I, scheduleI, runI, shapeI, gridC, runC, shapeC, exploreQuiet } from './leave-harness.ts'
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

//! the release shapes (DESIGN-LEAVE §10.10): the adversaries a rule for "a vote above my view" must stay live and
// safe on, pinned on today's kernel as the floor BEFORE the rule is measured. releasedEarly is evictTwo's cut shape
// with the grant 200 ms old when the ballot commits and the VIEW lost: red today on the same four seeds as evictTwo
// (seed 5 reaches the shape and misses the split's timing). Plainly, it is evictTwo with a delay and has no teeth
// evictTwo lacks (the second review): any clock shorter than the run splits both. The "commit 200 ms after the grant"
// check only guards that the slow link was in effect (true by construction when the ballot commits).
const SPLITS_RELEASED_EARLY = [1, 2, 3, 4]

test('leave harness, releasedEarly: a two-evictee ballot that commits 200 ms after the third voter\'s grant, the VIEW lost on the cut — today\'s kernel (which holds nothing) splits on exactly the pinned seeds, as evictTwo does; the slow link was in effect on all five', () => {
  const bad: number[] = [], detail: string[] = [], notTheShape: number[] = []
  for (let seed = 1; seed <= 5; seed++) {
    const ps = releasedEarly(seed)
    if (ps.some((p) => p.startsWith('not the shape'))) notTheShape.push(seed)
    else if (ps.length) { bad.push(seed); detail.push(`${seed}: ${ps.join('; ')}`) }
  }
  assert.deepEqual(notTheShape, [], 'the slow link was not in effect: the commit must come 200 ms after the grant on every seed')
  assert.deepEqual(bad, SPLITS_RELEASED_EARLY, `releasedEarly: the split set moved — a kernel change closed (or widened) the hole; re-record with the why\n${detail.join('\n')}`)
})

//! the four failed-ballot shapes of a TWO-evictee ballot, each one fixed schedule on real Nodes (DESIGN-LEAVE §10.10):
// the proposer dies for good with a stale majority alive (open, committed, and back from its dir); an abandoned
// ballot whose proposer restarts and retries at the same epoch (as a one-member ballot, or the same two-member one);
// two abandoned ballots in a row and a third that commits; the release racing a late VIEW. SAFE on today's kernel
// except lateView's mid point, which is the evictTwo window drawn on purpose (cc writable at 1 beside aa and bb at
// 2, the quiet-point test's witness) and is pinned RED as the exact state. LIVENESS is pinned as the exact end
// states and the exact read-only sets at the mid points, in ONE list: a rule that holds bb and cc after their grant
// for `{aa,bb,cc}`@2 moves these only with its release (the proposer's word: twoFailedBallots is its teeth — the
// abandoned ballot's granters are released twice by the proposer's disown; retrySameEpoch heals by the restarted
// proposer's same-epoch re-grant with or without the disown, the second review measured), its supersession
// (proposerDeadStale: the proposer is dead, only a ballot the held view's majority consents to may go on; its mid
// point is read two rounds after the death, before any chain gives up), and its re-read of the hold against the
// ballot it is for (retrySameEpoch one) — and re-records each with the why.
const DEAD_STALE_END = 'bb@3{bb,cc,dd,ee}W cc@3{bb,cc,dd,ee}W dd@3{bb,cc,dd,ee}W ee@3{bb,cc,dd,ee}W'
const DEAD_STALE_RESTART_END = 'bb@4{aa,bb,cc,dd,ee}W cc@4{aa,bb,cc,dd,ee}W dd@4{aa,bb,cc,dd,ee}W ee@4{aa,bb,cc,dd,ee}W aa@4{aa,bb,cc,dd,ee}W'
const RETRY_ONE_END = 'bb@2{aa,bb,cc,dd}W cc@2{aa,bb,cc,dd}W dd@2{aa,bb,cc,dd}W ee@2{aa,bb,cc,dd}r:evicted aa@2{aa,bb,cc,dd}W'
const RETRY_TWO_END = 'bb@2{aa,bb,cc}W cc@2{aa,bb,cc}W dd@2{aa,bb,cc}r:evicted ee@2{aa,bb,cc}r:evicted aa@2{aa,bb,cc}W'
const THREE_END = 'aa@2{aa,bb,cc}W bb@2{aa,bb,cc}W cc@2{aa,bb,cc}W dd@2{aa,bb,cc}r:evicted ee@2{aa,bb,cc}r:evicted'
const LATE_VIEW_MID = 'aa@2{aa,bb,cc}W bb@2{aa,bb,cc}W cc@1{aa,bb,cc,dd,ee}W dd@2{aa,bb,cc}r:evicted ee@2{aa,bb,cc}r:evicted'
//! the mid-point read-only sets today: nobody after a dead proposer's ballot or an abandoned one (the base reads no vote)
const KNOWN_READ_ONLY_MID: Record<string, string[][]> = { 'proposerDeadStale open': [[]], 'proposerDeadStale committed': [[]], 'proposerDeadStale restart': [[]], 'retrySameEpoch one': [[]], 'retrySameEpoch two': [[]], twoFailedBallots: [[], []] }

test('leave harness, the failed two-evictee ballot: the proposer dead with a stale majority alive (open, committed, back from its dir); an abandoned ballot retried at the same epoch after the proposer\'s restart; two abandoned ballots then a commit; a late VIEW — SAFE on today\'s kernel but lateView\'s mid point (the evictTwo window, pinned red); every end state and mid read-only set exactly as pinned', () => {
  const runs: [string, ReturnType<typeof lateView>, string][] = [
    ['proposerDeadStale open', proposerDeadStale('open'), DEAD_STALE_END],
    ['proposerDeadStale committed', proposerDeadStale('committed'), DEAD_STALE_END],
    ['proposerDeadStale restart', proposerDeadStale('restart'), DEAD_STALE_RESTART_END],
    ['retrySameEpoch one', retrySameEpoch('one'), RETRY_ONE_END],
    ['retrySameEpoch two', retrySameEpoch('two'), RETRY_TWO_END],
    ['twoFailedBallots', twoFailedBallots(), THREE_END],
    ['lateView', lateView(), THREE_END],
  ]
  //! safety first: the shape, one view per epoch, and the quiet point of every shape in one list
  const unsafeOnes = runs.flatMap(([name, o]) => [...o.shape, ...o.splits, ...(o.quiet ? [o.quiet] : [])].map((p) => `${name}: ${p}`))
  assert.deepEqual(unsafeOnes, [], 'not the shape, or UNSAFE')
  //! the red-today witness: lateView's window, two writable views before the late VIEW lands
  const [, late] = runs[6]
  assert.equal(late.mid![0], LATE_VIEW_MID, 'lateView: the mid point moved — a kernel that holds cc on its vote closes the evictTwo window; re-record with the why')
  //! liveness, one list: the end state of every shape and the read-only set at every mid point
  const teeth: string[] = []
  for (const [name, o, end] of runs) {
    if (o.end !== end) teeth.push(`${name}: the end state moved — a rule that holds a vote above the view must say how it is released or superseded; re-record with the why: ${o.end}`)
    const known = KNOWN_READ_ONLY_MID[name]
    if (known) o.mid!.forEach((s, i) => { if (readOnlyOf(s).join(' ') !== known[i].join(' ')) teeth.push(`${name}: the read-only set at mid point ${i + 1} moved; re-record with the why: ${s}`) })
  }
  assert.deepEqual(teeth, [])
})

//! the second review's shapes (DESIGN-LEAVE §10.10, 2026-10-10), pinned on today's kernel. Two are the base's hole
// drawn again and are RED today, pinned as the exact state: lateAsk — evictTwo's witness with the held member's
// heartbeat late for four rounds, cc writable at 1 beside aa and bb at 2 at every point (a rule that holds cc must
// show ONE writable view at every point, however late cc's timer: a stayer whose memory of cc's ask expires on a
// clock shows two again the round it expires, with every link up — the review's blocker against a two-tick memory);
// keptBallotReversed — the kept ballot granted from view 1 (one apart) and installed over by view 2 (two apart),
// the same quiet-point split and epoch-4 split as keptBallot. Three are LIVE today and pinned as end states, each a
// shape the rule must answer: allHeld (every live member holds the dead proposer's view: nobody may lead unless a
// held member may, jointly over its own hold), genesisProposerDies (the same at epoch 0: a granter's vote is n
// members apart from its empty view), and proposerAndGranterDie (the rule's cost with no cut among the living: cc
// holds `{aa,bb,cc}`, a ballot joint over it needs two of its three members, and only cc is alive — read-only for
// good, the CP answer; the rule moves this pin with that why).
const LATE_ASK_MIDS = [1, 2, 3, 4].map((late) => `late ${late}: aa@2{aa,bb,cc}W bb@2{aa,bb,cc}W cc@1{aa,bb,cc,dd,ee}W dd@1{aa,bb,cc,dd,ee}W ee@1{aa,bb,cc,dd,ee}W | writable views 2`)
  .concat('cc ticks: aa@2{aa,bb,cc}W bb@2{aa,bb,cc}W cc@1{aa,bb,cc,dd,ee}W dd@1{aa,bb,cc,dd,ee}W ee@1{aa,bb,cc,dd,ee}W | writable views 2')
const LATE_ASK_QUIET = 'writable in different views: aa@2{aa,bb,cc} bb@2{aa,bb,cc} cc@1{aa,bb,cc,dd,ee} dd@1{aa,bb,cc,dd,ee} ee@1{aa,bb,cc,dd,ee}'
const ALL_HELD_END = 'bb@3{bb,cc,dd,ee}W cc@3{bb,cc,dd,ee}W dd@3{bb,cc,dd,ee}W ee@3{bb,cc,dd,ee}W'
const GENESIS_END: Record<3 | 5, string> = { 3: 'bb@2{bb,cc}W cc@2{bb,cc}W', 5: 'bb@2{bb,cc,dd,ee}W cc@2{bb,cc,dd,ee}W dd@2{bb,cc,dd,ee}W ee@2{bb,cc,dd,ee}W' }
const GRANTER_DIE_END = 'cc@3{cc,dd,ee}W dd@3{cc,dd,ee}W ee@3{cc,dd,ee}W'

test('leave harness, the second review\'s shapes: the held member\'s heartbeat late (lateAsk) and the kept ballot in the reversed order (keptBallotReversed) — today\'s kernel is writable in two views, pinned exactly; every live member held (allHeld), the first proposer dead at genesis, the proposer and a granter dead — SAFE, and today\'s kernel re-forms on every one, pinned as the exact end states', () => {
  const la = lateAsk(), kr = keptBallotReversed()
  const live: [string, ReturnType<typeof allHeld>, string][] = [
    ...(['open', 'committed'] as const).map((v) => [`allHeld ${v}`, allHeld(v), ALL_HELD_END] as [string, ReturnType<typeof allHeld>, string]),
    ...([3, 5] as const).flatMap((n) => (['open', 'committed'] as const).map((v) => [`genesisProposerDies n=${n} ${v}`, genesisProposerDies(n, v), GENESIS_END[n]] as [string, ReturnType<typeof allHeld>, string])),
    ...(['open', 'committed'] as const).map((v) => [`proposerAndGranterDie ${v}`, proposerAndGranterDie(v), GRANTER_DIE_END] as [string, ReturnType<typeof allHeld>, string]),
  ]
  //! safety first, one list: the shape of every run, and no split anywhere on the three live shapes
  const unsafeOnes = [...la.shape.map((p) => `lateAsk: ${p}`), ...kr.shape.map((p) => `keptBallotReversed: ${p}`), ...live.flatMap(([name, o]) => [...o.shape, ...o.splits, ...(o.quiet ? [o.quiet] : [])].map((p) => `${name}: ${p}`))]
  assert.deepEqual(unsafeOnes, [], 'not the shape, or UNSAFE')
  //! the red-today witnesses, one list
  const red: string[] = []
  if (la.mid!.join('\n') !== LATE_ASK_MIDS.join('\n')) red.push(`lateAsk: a mid point moved — a kernel that holds cc must show one writable view at every point, however late cc's timer; re-record with the why:\n${la.mid!.join('\n')}`)
  if (la.quiet !== LATE_ASK_QUIET) red.push(`lateAsk: the quiet point moved: ${la.quiet}`)
  if (kr.quiet !== KEPT_BALLOT_QUIET) red.push(`keptBallotReversed: the quiet point moved: ${kr.quiet}`)
  if (kr.splits.join('|') !== KEPT_BALLOT_SPLITS.join('|')) red.push(`keptBallotReversed: the epoch-4 split moved: ${kr.splits.join('; ') || 'none'}`)
  if (kr.end !== KEPT_BALLOT_END) red.push(`keptBallotReversed: the end state moved: ${kr.end}`)
  assert.deepEqual(red, [], 'a kernel change closed (or widened) a hole of today\'s kernel; re-record with the why')
  //! liveness, one list: the end state of every live shape
  const teeth: string[] = []
  for (const [name, o, end] of live) if (o.end !== end) teeth.push(`${name}: the end state moved — a rule that holds a vote above the view must say who leads and what it costs; re-record with the why: ${o.end}`)
  assert.deepEqual(teeth, [])
})

//! the third review's shapes (DESIGN-LEAVE §10.10, 2026-10-10), pinned on today's kernel. Two are LIVE today, pinned
// as end states: clientAsk — a client's HELLO and PULL name a hold that does not exist, and aa's one-member eviction
// commits on the first ballot all the same (I-23: a client's word teaches nothing; the first fixed scratch kernel
// read the hold and never committed); genesisProposerAndGranterDie — one survivor with memory at epoch 0 beside a
// newcomer, or beside the two others reborn memory-only, forms a view today (the rule's cost at epoch 0: the CP
// answer, pinned so the move carries its why; the reborn pair is drawn `open` only, because in the `committed`
// variant today's kernel installs a second view at epoch 1 beside aa's — the genesis class below, the rebirth rule).
// Two are RED today, pinned as the exact states: freshLink — the held member's link to a stayer flaps, and today's
// kernel counts the fresh link at once (dd writable at 1 beside aa and bb at 2 at both points: a rule that holds cc
// must show dd read-only from the instant of the admit, not one round trip later); genesisSplit — two granters cut
// from the proposer before the VIEW form a view of their own at the SAME epoch the proposer's side reaches next,
// both writable (hostless genesis; the Sim's cluster() gives every node hosts, so no Sim family draws it).
const CLIENT_ASK_END = 'aa@2{aa,bb,cc,dd}W bb@2{aa,bb,cc,dd}W cc@2{aa,bb,cc,dd}W dd@2{aa,bb,cc,dd}W ee@2{aa,bb,cc,dd}r:evicted'
const FRESH_LINK_MIDS = ['admitted', 'landed'].map((at) => `${at}: aa@2{aa,bb,cc}W bb@2{aa,bb,cc}W cc@1{aa,bb,cc,dd,ee}W dd@1{aa,bb,cc,dd,ee}W ee@1{aa,bb,cc,dd,ee}W | writable views 2`)
const GENESIS_GRANTER_DIE_END: Record<'fresh' | 'reborn', string> = { fresh: 'bb@2{bb,dd}W dd@2{bb,dd}W', reborn: 'bb@1{a2,bb,c2}W a2@1{a2,bb,c2}W c2@1{a2,bb,c2}W' }
//! the proposals and bb's vote (the fourth review): today one ballot forms the view, and bb's vote carries nothing.
// A rule that freezes these shapes re-proposes at every age-out, and must do so at the SAME epoch with ONE earlier
// vote behind bb's: without the same-members clause (§10.10.2) every re-offer is refused, the epoch burns, the list
// climbs (`P(3,3) P(4,3)`) and bb's vote climbs with it, one earlier vote per burn.
const GENESIS_GRANTER_DIE_MIDS: Record<'fresh' | 'reborn', string[]> = { fresh: ['proposals: bb=P(2,2) dd=-', 'bb vote: e=2 p=bb prior=0'], reborn: ['proposals: bb=- a2=P(1,3) c2=-', 'bb vote: e=1 p=aa prior=0'] }
const GENESIS_SPLIT_QUIET = 'writable in different views: aa@2{aa,bb,cc} bb@2{aa,bb,cc} cc@2{aa,bb,cc} dd@2{dd,ee} ee@2{dd,ee}'
const GENESIS_SPLIT_SPLITS = ['aa', 'bb', 'cc'].map((u) => `epoch 2: {dd,ee} vs {aa,bb,cc} (at ${u})`)
const GENESIS_SPLIT_END = 'aa@2{aa,bb,cc}W bb@2{aa,bb,cc}W cc@2{aa,bb,cc}W dd@2{dd,ee}W ee@2{dd,ee}W'

test('leave harness, the third review\'s shapes: a client\'s word names a hold (clientAsk) and the one survivor of a genesis ballot meets a newcomer or a reborn pair (genesisProposerAndGranterDie) — SAFE, and today\'s kernel commits on every one, pinned as the exact end states; a held member\'s link flaps (freshLink) and two granters cut before the VIEW at genesis (genesisSplit) — today\'s kernel is writable in two views, pinned exactly', () => {
  const ca = clientAsk(), fl = freshLink(), gs = genesisSplit()
  const live: [string, ReturnType<typeof clientAsk>, string][] = [
    ['clientAsk', ca, CLIENT_ASK_END],
    ...(['open', 'committed'] as const).map((v) => [`genesisProposerAndGranterDie ${v} fresh`, genesisProposerAndGranterDie(v, 'fresh'), GENESIS_GRANTER_DIE_END.fresh] as [string, ReturnType<typeof clientAsk>, string]),
    ['genesisProposerAndGranterDie open reborn', genesisProposerAndGranterDie('open', 'reborn'), GENESIS_GRANTER_DIE_END.reborn],
  ]
  //! safety first, one list: the shape of every run, and no split anywhere on the live shapes
  const unsafeOnes = [...fl.shape.map((p) => `freshLink: ${p}`), ...gs.shape.map((p) => `genesisSplit: ${p}`), ...live.flatMap(([name, o]) => [...o.shape, ...o.splits, ...(o.quiet ? [o.quiet] : [])].map((p) => `${name}: ${p}`))]
  assert.deepEqual(unsafeOnes, [], 'not the shape, or UNSAFE')
  //! the red-today witnesses, one list
  const red: string[] = []
  if (fl.mid!.join('\n') !== FRESH_LINK_MIDS.join('\n')) red.push(`freshLink: a mid point moved — a kernel that holds cc must show dd read-only from the instant the fresh link is admitted; re-record with the why:\n${fl.mid!.join('\n')}`)
  if (fl.quiet !== LATE_ASK_QUIET) red.push(`freshLink: the quiet point moved: ${fl.quiet}`)
  if (gs.quiet !== GENESIS_SPLIT_QUIET) red.push(`genesisSplit: the quiet point moved: ${gs.quiet}`)
  if (gs.splits.join('|') !== GENESIS_SPLIT_SPLITS.join('|')) red.push(`genesisSplit: the epoch-2 split moved: ${gs.splits.join('; ') || 'none'}`)
  if (gs.end !== GENESIS_SPLIT_END) red.push(`genesisSplit: the end state moved: ${gs.end}`)
  assert.deepEqual(red, [], 'a kernel change closed (or widened) a hole of today\'s kernel; re-record with the why')
  //! liveness, one list: the end state of every live shape, and the one ballot clientAsk's eviction took
  const teeth: string[] = []
  for (const [name, o, end] of live) if (o.end !== end) teeth.push(`${name}: the end state moved — a rule that reads a hold must say whose word it reads and what the genesis hold costs; re-record with the why: ${o.end}`)
  if (ca.mid![0] !== 'aa proposed: P(2,4)') teeth.push(`clientAsk: aa did not commit the eviction on its first ballot — a client's word made it joint over members that do not exist (I-23): ${ca.mid![0]}`)
  //! the proposals and bb's vote of every genesisProposerAndGranterDie run: a rule that freezes it re-proposes at the
  // same epoch, or it is burning epochs (the same-members clause, §10.10.2)
  for (const [name, o] of live.slice(1)) { const want = GENESIS_GRANTER_DIE_MIDS[name.endsWith('reborn') ? 'reborn' : 'fresh']; if (o.mid!.join('\n') !== want.join('\n')) teeth.push(`${name}: the proposals or bb's vote moved — a frozen cluster must re-propose at the same epoch; re-record with the why:\n${o.mid!.join('\n')}`) }
  assert.deepEqual(teeth, [])
})

//! the fourth review's shapes (DESIGN-LEAVE §10.10, 2026-10-10), pinned on today's kernel: one pin per kernel line of
// the rule's wire, so a scratch kernel missing that one line goes red on its own pin. Three are LIVE today and pinned
// as exact states: clientGenesis — a client linked into aa before genesis names a hold by its HELLO or by a PULL at
// epoch 0, and genesis forms all the same (`P(1,3)` once; a proposer that reads every linked uuid's holds at epoch 0
// and takes a client's word never forms: one client stops genesis); serverAsk — a server in no view names a hold by
// its HELLO and a PULL, and aa's one-member eviction commits on the first ballot (`P(2,4)` once; a proposer that
// widens its ballot with ANY linked server's word, member or not, never commits: `P(2,4)` three times); helloHold —
// a stayer learns a hold from a fresh link's HELLO alone (at epoch 0 no ask goes out), the hold ends at the member's
// next install, and the stayer must count it again: aa is writable with cc and dd linked, three of five, at both mid
// points (a rule that never takes a HELLO's word back leaves aa `minority` there, with a reachable majority, until
// its own ballot — joint over the phantom hold — ages out and is disowned). One is RED today, pinned exactly per seed
// and link delay: freshLinkSim — freshLink on REAL HELLOs in the Sim (the mesh writes its own HELLO for every link,
// so freshLink never tests the node's), evictTwo's cut shape with the n03-n04 and n03-n05 links flapped 1.5 s after
// the cut; today's kernel is split before the flap and through the window on the seeds evictTwo splits on (4000 of
// 4000 ms), and on none of the others. A rule that holds n03 shows 0 everywhere ONLY when n03's own HELLO carries
// its hold; without it, the stayer counts the fresh link for one round trip and the window shows 15 to 160 ms.
const CLIENT_GENESIS_END = 'aa@1{aa,bb,cc}W bb@1{aa,bb,cc}W cc@1{aa,bb,cc}W'
const HELLO_HOLD_MIDS = [
  'aa with cc and dd: aa@1{aa,bb,cc,dd,ee}W bb@0{}W cc@1{aa,bb,cc,dd,ee}W dd@1{aa,bb,cc,dd,ee}W ee@0{}W',
  'three rounds: aa@1{aa,bb,cc,dd,ee}W bb@1{aa,bb,cc,dd,ee}r:minority cc@1{aa,bb,cc,dd,ee}W dd@1{aa,bb,cc,dd,ee}W ee@1{aa,bb,cc,dd,ee}W',
]
const HELLO_HOLD_END = 'aa@3{aa,cc,dd}W bb@3{aa,cc,dd}r:evicted cc@3{aa,cc,dd}W dd@3{aa,cc,dd}W ee@3{aa,cc,dd}r:evicted'
const FRESH_LINK_SIM: string[] = [
  'seed 1 delay 3-3: before [n03:W n04:W n05:W] split-ms 4000 of 4000; n04 gateOpen rows 0; monitors fired',
  'seed 2 delay 3-3: before [n03:W n04:W n05:W] split-ms 4000 of 4000; n04 gateOpen rows 0; monitors fired',
  'seed 3 delay 3-3: before [n03:W n04:W n05:W] split-ms 0 of 4000; n04 gateOpen rows 0; monitors quiet',
  'seed 4 delay 3-3: before [n03:W n04:W n05:W] split-ms 4000 of 4000; n04 gateOpen rows 0; monitors fired',
  'seed 5 delay 3-3: before [n03:W n04:W n05:W] split-ms 4000 of 4000; n04 gateOpen rows 0; monitors fired',
  'seed 1 delay 3-40: before [n03:W n04:W n05:W] split-ms 4000 of 4000; n04 gateOpen rows 0; monitors fired',
  'seed 2 delay 3-40: before [n03:W n04:W n05:W] split-ms 0 of 4000; n04 gateOpen rows 0; monitors quiet',
  'seed 3 delay 3-40: before [n03:W n04:W n05:W] split-ms 31 of 4000; n04 gateOpen rows 1; monitors quiet',
  'seed 4 delay 3-40: before [n03:W n04:W n05:W] split-ms 4000 of 4000; n04 gateOpen rows 0; monitors fired',
  'seed 5 delay 3-40: before [n03:W n04:W n05:W] split-ms 0 of 4000; n04 gateOpen rows 0; monitors quiet',
]

test('leave harness, the fourth review\'s shapes: a client\'s word at epoch 0 (clientGenesis) and a non-member server\'s word (serverAsk) teach nothing, and a hold learned from a HELLO alone is counted again when it ends (helloHold) — SAFE, and today\'s kernel is live on every one, pinned as the exact states; a held member\'s links flap on real HELLOs in the Sim (freshLinkSim) — today\'s kernel is split through the window on evictTwo\'s seeds, pinned exactly', () => {
  const live: [string, ReturnType<typeof clientAsk>, string, string[]][] = [
    ...(['hello', 'pull'] as const).map((via) => [`clientGenesis ${via}`, clientGenesis(via), CLIENT_GENESIS_END, ['aa proposed: P(1,3)']] as [string, ReturnType<typeof clientAsk>, string, string[]]),
    ['serverAsk', serverAsk(), CLIENT_ASK_END, ['aa proposed: P(2,4)']],
    ['helloHold', helloHold(), HELLO_HOLD_END, HELLO_HOLD_MIDS],
  ]
  //! safety first, one list: the shape, one view per epoch and the quiet point of every live shape
  const unsafeOnes = live.flatMap(([name, o]) => [...o.shape, ...o.splits, ...(o.quiet ? [o.quiet] : [])].map((p) => `${name}: ${p}`))
  assert.deepEqual(unsafeOnes, [], 'not the shape, or UNSAFE')
  //! the red-today witness: the Sim's window, exactly as today's kernel shows it per seed and delay
  const sim: string[] = []
  for (const d of [[3, 3], [3, 40]] as [number, number][]) for (let seed = 1; seed <= 5; seed++) sim.push(freshLinkSim(seed, d))
  assert.deepEqual(sim, FRESH_LINK_SIM, 'freshLinkSim: the window moved — a kernel that holds n03 must show 0 split-ms everywhere, and only its own HELLO carrying the hold makes it so; re-record with the why')
  //! liveness, one list: the end state and every mid point of the live shapes
  const teeth: string[] = []
  for (const [name, o, end, mids] of live) {
    if (o.end !== end) teeth.push(`${name}: the end state moved — a rule that reads a word must say whose, and take it back when it ends; re-record with the why: ${o.end}`)
    if (o.mid!.join('\n') !== mids.join('\n')) teeth.push(`${name}: a mid point moved — ${name === 'helloHold' ? 'a stayer that read a hold from a HELLO must count the member again when the hold ends' : 'a stranger\'s word widened the ballot'}; re-record with the why:\n${o.mid!.join('\n')}`)
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
