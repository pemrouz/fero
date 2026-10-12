//! The adversarial leave harness (DESIGN-LEAVE §9 step 2 and §10, 2026-10-10), pinned on the kernel WITH the release
// rule (§10.10, built 2026-10-12). The generators are in sim/leave-harness.ts; this file runs each family over its
// range and pins two things apart:
//   SAFETY  — ASSERTED on every schedule: no monitor fired (one-view-per-epoch above all) and no two nodes ended
//             WRITABLE in different views at a quiet point. The kernel before the rule (v4 at 35d7300, "the base"
//             below) was safe on every family here but four, which were pinned RED as the exact seeds or end state
//             they split on: evictTwo (two suspects evicted at once, the third voter cut on its grant), evictTwoB
//             (the same with the stale voter granting a never-voted member's higher ballot), keptBallot (a ballot kept
//             across an install commits two members apart from the view it was kept across, at n=4) and genesisSplit
//             (two granters cut before the VIEW form a second view at genesis). The rule closes all four: they are
//             pinned GREEN now, as empty split sets and safe end states, and a kernel that reopens one shows here.
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
// proposerDeadStale, retrySameEpoch, twoFailedBallots, lateView) pin what the rule's release keeps: safe where the
// base split (releasedEarly, lateView's window), live everywhere else — held members at the mid points, released by
// the proposer's disown or superseded by the held view's majority by the end. The second review of §10.10
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
// HELLOs in the Sim, since the mesh writes its own — red on the base as evictTwo was); and genesisProposerAndGranterDie
// now records every node's proposal list and bb's vote, so a rule that re-proposes while frozen is pinned to the SAME
// epoch. The fifth round (the page's last note; 2026-10-12) added askAfterHello, lostRelease and askAtAdmit, one per
// open item. THE BUILD (2026-10-12, V4-51): the four holes are closed and every red pin is re-recorded to the rule's
// safe state; the two liveness pins the rule moves on purpose are proposerAndGranterDie and
// genesisProposerAndGranterDie, the CP answer (§10.10.4, §10.10.1); the mid points of the release shapes show held
// members where the base showed writable ones; no pin of any existing family moved (rebirth, both isolate families,
// the crash grid, evictsplit, joinsplit, pledgeTwo, the flap and the proposer crash) — exactly §10.10.8's table.
// Bounded: about 30 s at low priority on the loaded WSL2
// box, half that idle; FERO_LEAVE_FULL=1 runs the full crash grid (576 cases, three restart delays, two seeds) and
// 100 seeded isolate schedules instead of 50.
import { test } from 'node:test'
import assert from 'node:assert'
import { meshState, evictsplit, joinsplit, twoLeavers, pledgeTwo, evictTwo, evictTwoB, keptBallot, flapDuringBallot, proposerCrash, releasedEarly, proposerDeadStale, retrySameEpoch, twoFailedBallots, lateView, lateAsk, allHeld, genesisProposerDies, proposerAndGranterDie, keptBallotReversed, clientAsk, freshLink, genesisProposerAndGranterDie, genesisSplit, clientGenesis, serverAsk, helloHold, freshLinkSim, askAfterHello, lostRelease, askAtAdmit, keptBallotProposerGone, readOnlyOf, scheduleR, runR, shapeR, NAMED_R, namedR, H9_SEEDS, GRID_I, scheduleI, runI, shapeI, gridC, runC, shapeC, exploreQuiet } from './leave-harness.ts'
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
// The run witness WAS the base's own hole (cc, dd and ee writable at 1 beside aa and bb at 2); under the rule cc's
// gate shuts on its vote at 2 for a view two apart from view 1 (`held`), dd and ee no longer count it (`minority`),
// and the check names nothing — re-recorded 2026-10-12 with that why. The hand pins above and below it do not depend
// on the kernel's ballot rules.
test('leave harness, the quiet-point check: two nodes writable in different views are named; one writable node is not; a two-evictee ballot with the third voter cut before its VIEW is NOT a split under the rule — cc is held, dd and ee are a minority without it', () => {
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
  assert.equal(quietSplit(five), null, 'cc is held on its vote for {aa,bb,cc}@2 and dd and ee do not count it: one writable view')
  assert.equal(meshState(five), 'aa@2{aa,bb,cc}W bb@2{aa,bb,cc}W cc@1{aa,bb,cc,dd,ee}r:held dd@1{aa,bb,cc,dd,ee}r:minority ee@1{aa,bb,cc,dd,ee}r:minority')
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
// the one-evictee control never splits (the arithmetic forbids it). CLOSED 2026-10-12 (V4-51): the sets are empty.
// n03 is held on its vote for {n01,n02,n03}@2, two apart from view 1; it leads {n03,n04,n05}@3 joint over that view,
// which needs n01 or n02 across the cut; n04 and n05 grant it and are held on it in turn; the far side stays
// read-only until the cut heals — the CP answer (§10.10.8). A kernel that reopens the hole fills these lists.
// evictTwoB is the same hole with the stale voter NOT the far side's lowest member: a node that never voted leads the
// far side and the stale voter GRANTS its higher ballot (seed 3 misses the timing, as in evictTwo). It is the schedule
// that a rule of "a vote above my view closes my gate and I lead nothing" does NOT close (measured on a scratch
// kernel: evictTwo 0 of 10, evictTwoB still 1, 2, 4, 5), and that one grant clause does (0 of 5) — DESIGN-LEAVE
// §10.2. Closed with evictTwo: n04 is held and grants n02 nothing that is not joint over {n01,n04,n05}, and n02's
// joint ballot needs n01 or n05. The base's sets were {cut: [1, 2, 4, 5], crash: [1, 2, 4, 5]} and [1, 2, 4, 5].
const SPLITS_EVICT_TWO = { cut: [] as number[], crash: [] as number[] }
const SPLITS_EVICT_TWO_B: number[] = []

test('leave harness, evictTwo: two suspects evicted at once at n=5 with the third voter cut or crashed on its grant — SAFE under the rule on every seed (the base split on 1, 2, 4 and 5: two views at one epoch, both sides writable); one evictee never splits; evictTwoB (the stale voter is not the far side\'s lowest, so it would GRANT a never-voted member\'s higher ballot) safe on every seed too', () => {
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
// three-part rule (the grant clause too) ends with no split anywhere and bb and cc read-only for good. CLOSED
// 2026-10-12 (V4-51) by form (β) at the voter: cc and dd, at view 2, REFUSE aa's ballot over view 1 (its PROPOSE
// carries o: 1), so the schedule's `shape` list now names exactly the three moves that no longer happen — the pin
// of the refusal (§10.10.9); aa installs view 2 evicted and holds nothing; bb and cc end writable at {bb,cc}@3 with
// dd `minority` and aa `evicted`: one writable view, no split at any epoch. The base: quiet point
// 'writable in different views: aa@3{aa,cc,dd} bb@2{bb,cc,dd} cc@2{bb,cc,dd} dd@3{aa,cc,dd}', two views at epoch 4,
// end 'aa@4{aa,dd}W bb@4{bb,cc}W cc@4{bb,cc}W dd@4{aa,dd}W'.
const KEPT_BALLOT_REFUSED = [
  'cc did not grant aa at 3 from view 2: aa@1{aa,bb,cc,dd}W bb@2{bb,cc,dd}W cc@2{bb,cc,dd}W dd@2{bb,cc,dd}W',
  'dd did not grant aa at 3 from view 2: aa@1{aa,bb,cc,dd}W bb@2{bb,cc,dd}W cc@2{bb,cc,dd}W dd@2{bb,cc,dd}W',
  'aa did not commit {aa,cc,dd}@3 on the kept ballot: aa@2{bb,cc,dd}r:evicted bb@2{bb,cc,dd}W cc@2{bb,cc,dd}W dd@2{bb,cc,dd}r:minority',
]
const KEPT_BALLOT_END = 'aa@2{bb,cc,dd}r:evicted bb@3{bb,cc}W cc@3{bb,cc}W dd@2{bb,cc,dd}r:minority'

test('leave harness, keptBallot: at n=4 the loser of a duel escalates over view 1, installs view 2 evicted and keeps the ballot — under the rule cc and dd REFUSE a ballot over a view below theirs, nothing commits on it, and the end is one writable view with no split at any epoch (the base: writable in two views at the quiet point, two views at epoch 4)', () => {
  const o = keptBallot()
  //! the pins in ONE list: the refusal (the moves the base made and the rule refuses), the quiet point, the epoch-4
  // split and the end state
  const moved: string[] = []
  if (o.shape.join('\n') !== KEPT_BALLOT_REFUSED.join('\n')) moved.push(`the refusal moved — the base's moves are the shape under the rule; re-record with the why:\n${o.shape.join('\n')}`)
  if (o.quiet !== null) moved.push(`two writable views at the quiet point: ${o.quiet}`)
  if (o.splits.length) moved.push(`two views at one epoch: ${o.splits.join('; ')}`)
  if (o.end !== KEPT_BALLOT_END) moved.push(`the end state moved: ${o.end}`)
  assert.deepEqual(moved, [], 'the kept ballot split again, or the rule\'s end state moved; re-record with the why')
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
// CLOSED 2026-10-12 (V4-51): the base split on [1, 2, 3, 4]; under the rule there is no clock, n03 holds until the
// cut heals, and the set is empty — a kernel whose hold ends on a clock fills it again.
const SPLITS_RELEASED_EARLY: number[] = []

test('leave harness, releasedEarly: a two-evictee ballot that commits 200 ms after the third voter\'s grant, the VIEW lost on the cut — SAFE under the rule on every seed (the base, holding nothing, split on four of five); the slow link was in effect on all five', () => {
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
//! lateView's mid point under the rule (2026-10-12): cc is HELD on its vote until the late VIEW lands — the evictTwo
// window is closed (the base: cc writable at 1 beside aa and bb at 2, two writable views)
const LATE_VIEW_MID = 'aa@2{aa,bb,cc}W bb@2{aa,bb,cc}W cc@1{aa,bb,cc,dd,ee}r:held dd@2{aa,bb,cc}r:evicted ee@2{aa,bb,cc}r:evicted'
//! the mid-point read-only sets under the rule (2026-10-12): after a dead proposer's two-evictee ballot bb and cc are
// held and dd and ee a minority without them, two rounds after the death, before bb leads the joint ballot that
// supersedes the held view (proposerDeadStale); after an abandoned ballot bb and cc are held until the restarted
// proposer's same-epoch re-grant (retrySameEpoch); after an abandoned ballot whose proposer is alive and linked, its
// disown releases both within the ten settle rounds (twoFailedBallots: nobody, as on the base — the disown's teeth)
const HELD_MID = ['bb@1{aa,bb,cc,dd,ee}r:held', 'cc@1{aa,bb,cc,dd,ee}r:held']
const DEAD_STALE_MID = [...HELD_MID, 'dd@1{aa,bb,cc,dd,ee}r:minority', 'ee@1{aa,bb,cc,dd,ee}r:minority']
const KNOWN_READ_ONLY_MID: Record<string, string[][]> = { 'proposerDeadStale open': [DEAD_STALE_MID], 'proposerDeadStale committed': [DEAD_STALE_MID], 'proposerDeadStale restart': [DEAD_STALE_MID], 'retrySameEpoch one': [HELD_MID], 'retrySameEpoch two': [HELD_MID], twoFailedBallots: [[], []] }

test('leave harness, the failed two-evictee ballot: the proposer dead with a stale majority alive (open, committed, back from its dir); an abandoned ballot retried at the same epoch after the proposer\'s restart; two abandoned ballots then a commit; a late VIEW — SAFE under the rule everywhere, lateView\'s window included (cc held until the VIEW lands); every end state as on the base, the mid read-only sets exactly as pinned (held members, released or superseded by the end)', () => {
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
  //! lateView's window: cc held, one writable view, before the late VIEW lands
  const [, late] = runs[6]
  assert.equal(late.mid![0], LATE_VIEW_MID, 'lateView: the mid point moved — cc must stay held on its vote until the VIEW lands; re-record with the why')
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
//! under the rule (2026-10-12): cc `held`, dd and ee `minority`, ONE writable view at every point however late cc's
// timer (the base: cc, dd and ee writable at 1 beside aa and bb at 2, two writable views at every point)
const WITNESS_HELD = 'aa@2{aa,bb,cc}W bb@2{aa,bb,cc}W cc@1{aa,bb,cc,dd,ee}r:held dd@1{aa,bb,cc,dd,ee}r:minority ee@1{aa,bb,cc,dd,ee}r:minority'
const LATE_ASK_MIDS = [1, 2, 3, 4].map((late) => `late ${late}: ${WITNESS_HELD} | writable views 1`).concat(`cc ticks: ${WITNESS_HELD} | writable views 1`)
//! keptBallotReversed under the rule: cc and dd grant from view 1 (one apart, no hold), install view 2 and are held
// by the re-read; bb is a minority without them; aa and dd end writable at {aa,dd}@4, no split at any epoch (the base:
// keptBallot's quiet point and epoch-4 split)
const KEPT_REVERSED_END = 'aa@4{aa,dd}W bb@2{bb,cc,dd}r:minority cc@2{bb,cc,dd}r:held dd@4{aa,dd}W'
const ALL_HELD_END = 'bb@3{bb,cc,dd,ee}W cc@3{bb,cc,dd,ee}W dd@3{bb,cc,dd,ee}W ee@3{bb,cc,dd,ee}W'
const GENESIS_END: Record<3 | 5, string> = { 3: 'bb@2{bb,cc}W cc@2{bb,cc}W', 5: 'bb@2{bb,cc,dd,ee}W cc@2{bb,cc,dd,ee}W dd@2{bb,cc,dd,ee}W ee@2{bb,cc,dd,ee}W' }
//! proposerAndGranterDie under the rule (2026-10-12): the CP answer, frozen ON PURPOSE (§10.10.4). cc holds a vote for
// {aa,bb,cc}@2; a ballot joint over it needs two of its three members and only cc lives; dd and ee grant cc's joint
// ballot and are held on it ({cc,dd,ee} is two apart from view 1): three live, linked members read-only for good,
// until an operator forgets the dead. The base re-formed {cc,dd,ee}@3 — which is UNSAFE when aa and bb are merely cut
// (evictTwo's split seen from cc), and from cc's seat dead and cut look the same.
const GRANTER_DIE_END = 'cc@1{aa,bb,cc,dd,ee}r:held dd@1{aa,bb,cc,dd,ee}r:held ee@1{aa,bb,cc,dd,ee}r:held'

test('leave harness, the second review\'s shapes: the held member\'s heartbeat late (lateAsk) and the kept ballot in the reversed order (keptBallotReversed) — one writable view at every point under the rule (the base: two); every live member held (allHeld) and the first proposer dead at genesis re-form as on the base; the proposer and a granter dead freezes the three survivors, the CP answer, pinned as the exact end states', () => {
  const la = lateAsk(), kr = keptBallotReversed()
  const live: [string, ReturnType<typeof allHeld>, string][] = [
    ...(['open', 'committed'] as const).map((v) => [`allHeld ${v}`, allHeld(v), ALL_HELD_END] as [string, ReturnType<typeof allHeld>, string]),
    ...([3, 5] as const).flatMap((n) => (['open', 'committed'] as const).map((v) => [`genesisProposerDies n=${n} ${v}`, genesisProposerDies(n, v), GENESIS_END[n]] as [string, ReturnType<typeof allHeld>, string])),
    ...(['open', 'committed'] as const).map((v) => [`proposerAndGranterDie ${v}`, proposerAndGranterDie(v), GRANTER_DIE_END] as [string, ReturnType<typeof allHeld>, string]),
  ]
  //! safety first, one list: the shape of every run, and no split anywhere on the three live shapes
  const unsafeOnes = [...la.shape.map((p) => `lateAsk: ${p}`), ...kr.shape.map((p) => `keptBallotReversed: ${p}`), ...live.flatMap(([name, o]) => [...o.shape, ...o.splits, ...(o.quiet ? [o.quiet] : [])].map((p) => `${name}: ${p}`))]
  assert.deepEqual(unsafeOnes, [], 'not the shape, or UNSAFE')
  //! the base's two holes, safe under the rule, one list
  const red: string[] = []
  if (la.mid!.join('\n') !== LATE_ASK_MIDS.join('\n')) red.push(`lateAsk: a mid point moved — a kernel that holds cc must show one writable view at every point, however late cc's timer; re-record with the why:\n${la.mid!.join('\n')}`)
  if (la.quiet !== null) red.push(`lateAsk: two writable views at the quiet point: ${la.quiet}`)
  if (kr.quiet !== null) red.push(`keptBallotReversed: two writable views at the quiet point: ${kr.quiet}`)
  if (kr.splits.length) red.push(`keptBallotReversed: two views at one epoch: ${kr.splits.join('; ')}`)
  if (kr.end !== KEPT_REVERSED_END) red.push(`keptBallotReversed: the end state moved: ${kr.end}`)
  assert.deepEqual(red, [], 'a hole of the base is open again, or the rule\'s state moved; re-record with the why')
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
//! freshLink under the rule (2026-10-12): dd `minority` from the INSTANT the fresh link is admitted — cc's HELLO
// carries its hold — and after every frame has landed; one writable view at both points (the base: dd writable at 1
// beside aa and bb at 2 at both, two writable views)
const FRESH_LINK_MIDS = ['admitted', 'landed'].map((at) => `${at}: ${WITNESS_HELD} | writable views 1`)
//! genesisProposerAndGranterDie under the rule (2026-10-12): the CP answer at epoch 0, frozen ON PURPOSE (§10.10.1).
// bb's vote for {aa,bb,cc}@1 is a hold three apart from its empty view; every ballot it leads or grants is joint
// over it and needs two of its three members, and only bb lives: a newcomer or the reborn pair never forms a view
// with it, until an operator forgets the dead or starts bb fresh. The base formed {bb,dd}@2 and {a2,bb,c2}@1 (the
// latter a second view at epoch 1 beside aa's in the committed variant: the genesis class the rule closes).
const GENESIS_GRANTER_DIE_END: Record<'fresh' | 'reborn', string> = { fresh: 'bb@0{}W dd@0{}W', reborn: 'bb@0{}W a2@0{}W c2@0{}W' }
//! the proposals and bb's vote (the fourth review): frozen, bb (or a2) re-proposes at every age-out, and does so at
// the SAME epoch with ONE earlier vote behind bb's — the same-members clause (§10.10.2): a ballot whose member set IS
// the held view's is joint over it by construction, so the re-offer at the new epoch is granted and no epoch burns.
// Without the clause every re-offer is refused, the epoch burns, the list climbs (`P(3,3) P(4,3)`) and bb's vote
// climbs with it, one earlier vote per burn. The base: `P(2,2)` and `P(1,3)` once, bb's vote carrying nothing.
const GENESIS_GRANTER_DIE_MIDS: Record<'fresh' | 'reborn', string[]> = {
  fresh: ['proposals: bb=P(2,2) P(2,2) P(2,2) P(2,2) P(2,2) P(2,2) dd=-', 'bb vote: e=2 p=bb prior=1'],
  reborn: ['proposals: bb=- a2=P(1,3) P(2,3) P(2,3) P(2,3) P(2,3) P(2,3) c2=-', 'bb vote: e=2 p=a2 prior=1'],
}
//! genesisSplit under the rule (2026-10-12): dd's and ee's genesis votes are holds five apart from the empty view;
// dd's {dd,ee}@2 is joint over the five and needs three of them, so dd and ee stay at epoch 0 — open genesis, in no
// view, no split (the base: two views at epoch 2, both writable, the recorder firing three times)
const GENESIS_SPLIT_END = 'aa@2{aa,bb,cc}W bb@2{aa,bb,cc}W cc@2{aa,bb,cc}W dd@0{}W ee@0{}W'

test('leave harness, the third review\'s shapes: a client\'s word names a hold (clientAsk) and the one survivor of a genesis ballot meets a newcomer or a reborn pair (genesisProposerAndGranterDie) — the client\'s word teaches nothing, as on the base; the survivor never forms a view, the CP answer at epoch 0, pinned exactly; a held member\'s link flaps (freshLink) and two granters cut before the VIEW at genesis (genesisSplit) — one writable view under the rule (the base: two), pinned exactly', () => {
  const ca = clientAsk(), fl = freshLink(), gs = genesisSplit()
  const live: [string, ReturnType<typeof clientAsk>, string][] = [
    ['clientAsk', ca, CLIENT_ASK_END],
    ...(['open', 'committed'] as const).map((v) => [`genesisProposerAndGranterDie ${v} fresh`, genesisProposerAndGranterDie(v, 'fresh'), GENESIS_GRANTER_DIE_END.fresh] as [string, ReturnType<typeof clientAsk>, string]),
    ['genesisProposerAndGranterDie open reborn', genesisProposerAndGranterDie('open', 'reborn'), GENESIS_GRANTER_DIE_END.reborn],
  ]
  //! safety first, one list: the shape of every run, and no split anywhere on the live shapes
  const unsafeOnes = [...fl.shape.map((p) => `freshLink: ${p}`), ...gs.shape.map((p) => `genesisSplit: ${p}`), ...live.flatMap(([name, o]) => [...o.shape, ...o.splits, ...(o.quiet ? [o.quiet] : [])].map((p) => `${name}: ${p}`))]
  assert.deepEqual(unsafeOnes, [], 'not the shape, or UNSAFE')
  //! the base's two holes, safe under the rule, one list
  const red: string[] = []
  if (fl.mid!.join('\n') !== FRESH_LINK_MIDS.join('\n')) red.push(`freshLink: a mid point moved — a kernel that holds cc must show dd read-only from the instant the fresh link is admitted; re-record with the why:\n${fl.mid!.join('\n')}`)
  if (fl.quiet !== null) red.push(`freshLink: two writable views at the quiet point: ${fl.quiet}`)
  if (gs.quiet !== null) red.push(`genesisSplit: two writable views at the quiet point: ${gs.quiet}`)
  if (gs.splits.length) red.push(`genesisSplit: two views at one epoch: ${gs.splits.join('; ')}`)
  if (gs.end !== GENESIS_SPLIT_END) red.push(`genesisSplit: the end state moved: ${gs.end}`)
  assert.deepEqual(red, [], 'a hole of the base is open again, or the rule\'s state moved; re-record with the why')
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
// the cut. The count is the far side's writable split only (item 3 of §10.10's last note, 2026-10-12): a ms in which
// a far-side node is writable at view 1 beside a node writable at a higher view — and the run is "not the shape"
// unless n01's view at 2 evicts both. Today's kernel re-forms the far side as `{n03,n04,n05}`@3 within the 1.5 s
// before the flap on every seed that reaches the shape (the chains at this cadence give up in about a second), so the
// window counts 0 there while the monitors name the split (two views at epoch 3); the seeds whose first eviction
// takes one suspect (the other chain still dialing) are not the shape. A rule that holds n03 never re-forms the far
// side, and shows 0 ONLY when n03's own HELLO carries its hold; without it, the stayer counts the fresh link for one
// round trip and the window shows 15 to 160 ms (measured on the scratch kernel at the old count; re-measured here).
const CLIENT_GENESIS_END = 'aa@1{aa,bb,cc}W bb@1{aa,bb,cc}W cc@1{aa,bb,cc}W'
const HELLO_HOLD_MIDS = [
  'aa with cc and dd: aa@1{aa,bb,cc,dd,ee}W bb@0{}W cc@1{aa,bb,cc,dd,ee}W dd@1{aa,bb,cc,dd,ee}W ee@0{}W',
  'three rounds: aa@1{aa,bb,cc,dd,ee}W bb@1{aa,bb,cc,dd,ee}r:minority cc@1{aa,bb,cc,dd,ee}W dd@1{aa,bb,cc,dd,ee}W ee@1{aa,bb,cc,dd,ee}W',
]
const HELLO_HOLD_END = 'aa@3{aa,cc,dd}W bb@3{aa,cc,dd}r:evicted cc@3{aa,cc,dd}W dd@3{aa,cc,dd}W ee@3{aa,cc,dd}r:evicted'
//! under the rule (2026-10-12): n03 `held` and n04, n05 `held` or `minority` before the flap on every seed that reaches
// the shape, 0 split-ms through the window, the monitors quiet — n03's own HELLO carries its hold, so n04 admits the
// fresh link knowing it (minus that line the window shows 15 to 160 ms per flap). The base: the far side re-formed
// at 3 before the flap on the same seeds, the monitors firing. Seed 3 at 3-40 reaches the shape under the rule and
// seed 5 does not (the base the other way round): the rule moved n01's chains by a frame.
const FRESH_LINK_SIM: string[] = [
  'seed 1 delay 3-3: before [n03:held n04:held n05:held] split-ms 0 of 4000; n04 gateOpen rows 0; monitors quiet',
  'seed 2 delay 3-3: before [n03:held n04:held n05:held] split-ms 0 of 4000; n04 gateOpen rows 0; monitors quiet',
  'seed 3 delay 3-3: not the shape: n01\'s view at 2 is {n01,n02,n03,n05}, not the two-evictee one',
  'seed 4 delay 3-3: before [n03:held n04:minority n05:minority] split-ms 0 of 4000; n04 gateOpen rows 0; monitors quiet',
  'seed 5 delay 3-3: before [n03:held n04:minority n05:minority] split-ms 0 of 4000; n04 gateOpen rows 0; monitors quiet',
  'seed 1 delay 3-40: before [n03:held n04:minority n05:minority] split-ms 0 of 4000; n04 gateOpen rows 0; monitors quiet',
  'seed 2 delay 3-40: not the shape: n01\'s view at 2 is {n01,n02,n03,n05}, not the two-evictee one',
  'seed 3 delay 3-40: before [n03:held n04:minority n05:minority] split-ms 0 of 4000; n04 gateOpen rows 0; monitors quiet',
  'seed 4 delay 3-40: before [n03:held n04:minority n05:minority] split-ms 0 of 4000; n04 gateOpen rows 0; monitors quiet',
  'seed 5 delay 3-40: not the shape: n01\'s view at 2 is {n01,n02,n03,n04}, not the two-evictee one',
]

test('leave harness, the fourth review\'s shapes: a client\'s word at epoch 0 (clientGenesis) and a non-member server\'s word (serverAsk) teach nothing, and a hold learned from a HELLO alone is counted again when it ends (helloHold) — SAFE, and today\'s kernel is live on every one, pinned as the exact states; a held member\'s links flap on real HELLOs in the Sim (freshLinkSim) — n03 held, no split before the flap or through the window on any seed (the base had re-formed the far side at 3 before the flap), pinned exactly', () => {
  const live: [string, ReturnType<typeof clientAsk>, string, string[]][] = [
    ...(['hello', 'pull'] as const).map((via) => [`clientGenesis ${via}`, clientGenesis(via), CLIENT_GENESIS_END, ['aa proposed: P(1,3)']] as [string, ReturnType<typeof clientAsk>, string, string[]]),
    ['serverAsk', serverAsk(), CLIENT_ASK_END, ['aa proposed: P(2,4)']],
    ['helloHold', helloHold(), HELLO_HOLD_END, HELLO_HOLD_MIDS],
  ]
  //! safety first, one list: the shape, one view per epoch and the quiet point of every live shape
  const unsafeOnes = live.flatMap(([name, o]) => [...o.shape, ...o.splits, ...(o.quiet ? [o.quiet] : [])].map((p) => `${name}: ${p}`))
  assert.deepEqual(unsafeOnes, [], 'not the shape, or UNSAFE')
  //! the Sim's window, exactly per seed and delay: 0 split-ms everywhere under the rule
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

//! the fifth round's shapes (DESIGN-LEAVE §10.10's last note; built 2026-10-12), pinned on today's kernel as exact
// states, one per open item of the note: askAfterHello — a hold announced by a HELLO on one link must reach every
// member link at the next change (a stayer that linked before the hold counts the held member for a heartbeat
// otherwise); lostRelease — a release lost on a cut is learned from the fresh link's HELLO, which names no hold (the
// `onAdmit` line that takes the old word back; without it dd is `minority` for good with three of five linked);
// askAtAdmit — the holds changed while the HELLO was in flight, so the ask goes out on the fresh link at admit (the
// other `onAdmit` line; without it dd is `minority` for good). Under the rule (2026-10-12): askAfterHello — dd `held`
// and cc `minority` the instant dd's install has landed (the ask went on every member link; a kernel that kept the
// HELLO's key as the last word shows cc writable there, counting a held dd, until dd's next tick), and a live end
// once bb is back to disown; lostRelease — dd `minority` after the abandon (bb and cc held), and writable again
// once the fresh HELLO took bb's old word back (ee still counts bb and cc at the abandon: their asks to it have not landed); askAtAdmit — dd `minority` at the admit (it knows the hold bb's HELLO
// carried) and writable once bb's ask on that link landed. The base read no hold: writable at every point but where
// the links alone made dd a minority.
const ASK_AFTER_HELLO_MIDS = [
  'dd installed: aa@1{aa,bb,cc,dd}r:minority bb@0{}W cc@1{aa,bb,cc,dd}r:minority dd@1{aa,bb,cc,dd}r:held ee@1{aa,bb,cc,dd}r:joining',
  'one round: aa@1{aa,bb,cc,dd}r:minority bb@0{}W cc@1{aa,bb,cc,dd}r:minority dd@1{aa,bb,cc,dd}r:held ee@1{aa,bb,cc,dd}r:joining',
]
const ASK_AFTER_HELLO_END = 'aa@3{aa,cc,dd}W bb@3{aa,cc,dd}r:evicted cc@3{aa,cc,dd}W dd@3{aa,cc,dd}W ee@3{aa,cc,dd}r:joining'
const FIVE_W = 'aa@1{aa,bb,cc,dd,ee}W bb@1{aa,bb,cc,dd,ee}W cc@1{aa,bb,cc,dd,ee}W dd@1{aa,bb,cc,dd,ee}W ee@1{aa,bb,cc,dd,ee}W'
const DD_MINORITY = 'aa@1{aa,bb,cc,dd,ee}W bb@1{aa,bb,cc,dd,ee}W cc@1{aa,bb,cc,dd,ee}W dd@1{aa,bb,cc,dd,ee}r:minority ee@1{aa,bb,cc,dd,ee}W'
const LOST_RELEASE_MIDS = ['abandoned: aa@1{aa,bb,cc,dd,ee}W bb@1{aa,bb,cc,dd,ee}r:held cc@1{aa,bb,cc,dd,ee}r:held dd@1{aa,bb,cc,dd,ee}r:minority ee@1{aa,bb,cc,dd,ee}W', `released, the bb-dd frame lost: ${DD_MINORITY}`, `re-linked: ${FIVE_W}`]
const ASK_AT_ADMIT_MIDS = [`released before the admit: ${DD_MINORITY}`, `admitted: ${DD_MINORITY}`, `landed: ${FIVE_W}`]

test('leave harness, the fifth round\'s shapes: a hold announced by one HELLO reaches every member link at the next change (askAfterHello), a release lost on a cut is learned from the fresh HELLO (lostRelease), and holds that changed while the HELLO was in flight are asked at admit (askAtAdmit) — SAFE, pinned exactly: a held dd, a minority cc, and dd writable again once the word is taken back', () => {
  const runs: [string, ReturnType<typeof askAfterHello>, string, string[]][] = [
    ['askAfterHello', askAfterHello(), ASK_AFTER_HELLO_END, ASK_AFTER_HELLO_MIDS],
    ['lostRelease', lostRelease(), FIVE_W, LOST_RELEASE_MIDS],
    ['askAtAdmit', askAtAdmit(), FIVE_W, ASK_AT_ADMIT_MIDS],
  ]
  //! safety first, one list: the shape, one view per epoch and the quiet point of every run
  const unsafeOnes = runs.flatMap(([name, o]) => [...o.shape, ...o.splits, ...(o.quiet ? [o.quiet] : [])].map((p) => `${name}: ${p}`))
  assert.deepEqual(unsafeOnes, [], 'not the shape, or UNSAFE')
  //! liveness, one list: the end state and every mid point
  const teeth: string[] = []
  for (const [name, o, end, mids] of runs) {
    if (o.end !== end) teeth.push(`${name}: the end state moved; re-record with the why: ${o.end}`)
    if (o.mid!.join('\n') !== mids.join('\n')) teeth.push(`${name}: a mid point moved — ${name === 'askAfterHello' ? 'a stayer must stop counting a held member the instant its install has landed, not a heartbeat later' : name === 'lostRelease' ? 'a fresh HELLO that names no hold must take the old word back' : 'holds that changed while the HELLO was in flight must be asked on the fresh link at admit'}; re-record with the why:\n${o.mid!.join('\n')}`)
  }
  assert.deepEqual(teeth, [])
})

//! the explorer's range here starts ABOVE the 1..2000 sim/explore.test.ts pins, so every seed adds coverage (the
// one-view-per-epoch recorder on new schedules, and the quiet check on all of them) instead of re-running a pinned one
//! keptBallotProposerGone (the fifth review, 2026-10-12, after the build): the kept ballot in the reversed order with its
// proposer GONE — destroyed with the ballot open or after committing with its VIEW unsent, or alive but evicted at
// view 2 and cut from bb. The rule as first built froze bb (`minority`) and cc and dd (`held`) for good although cc and
// dd are two of the held view's three and linked: nobody opened a ballot (aa is no member of view 2, so nobody's
// suspect; no knock, no leave) and nobody asked aa (the ask went to members only) — the page's liveness claim denied
// the shape. Now `evicted` is released by aa's disown the moment the asks land (before any tick; bb proposes nothing
// new), and `open` and `committed` by the ballot bb OPENS: `{bb,cc,dd}`@4, past the hold's epoch, joint over
// `{aa,cc,dd}`, superseded on cc's and dd's consent. The proposal lists tell the two mechanisms apart: without the ask
// to the proposer, `evicted` would show cc and dd held after the asks land and heal by the opener (`P(4,3)`); without
// the opener, `open` and `committed` stay frozen at the held mid.
const PROPOSER_GONE_HELD = 'bb@2{bb,cc,dd}W cc@2{bb,cc,dd}r:held dd@2{bb,cc,dd}r:held'
const PROPOSER_GONE: Record<'open' | 'committed' | 'evicted', { mid: string[]; end: string }> = {
  open: { mid: [`after the install: aa@1{aa,bb,cc,dd}W ${PROPOSER_GONE_HELD}`, 'proposals: bb=P(2,3) P(4,3)'], end: 'bb@4{bb,cc,dd}W cc@4{bb,cc,dd}W dd@4{bb,cc,dd}W' },
  committed: { mid: [`after the install: aa@3{aa,cc,dd}W ${PROPOSER_GONE_HELD}`, 'proposals: bb=P(2,3) P(4,3)'], end: 'bb@4{bb,cc,dd}W cc@4{bb,cc,dd}W dd@4{bb,cc,dd}W' },
  evicted: { mid: [`after the install: aa@2{bb,cc,dd}r:evicted ${PROPOSER_GONE_HELD}`, 'asks landed: aa@2{bb,cc,dd}r:evicted bb@2{bb,cc,dd}W cc@2{bb,cc,dd}W dd@2{bb,cc,dd}W', 'proposals: bb=P(2,3)'], end: 'aa@2{bb,cc,dd}r:evicted bb@2{bb,cc,dd}W cc@2{bb,cc,dd}W dd@2{bb,cc,dd}W' },
}

test('leave harness, the fifth review\'s shape: the kept ballot in the reversed order with its proposer GONE (keptBallotProposerGone) — destroyed open or committed, or alive but evicted — SAFE, and every live member writable again: the evicted proposer disowns the instant it is asked, the dead one\'s hold is superseded by the ballot the lowest live member OPENS over it (the rule as first built froze all three for good), pinned exactly', () => {
  const red: string[] = []
  for (const v of ['open', 'committed', 'evicted'] as const) {
    const o = keptBallotProposerGone(v)
    assert.deepEqual([...o.shape, ...o.splits, ...(o.quiet ? [o.quiet] : [])], [], `${v}: not the shape, or UNSAFE`)
    if (o.mid!.join('\n') !== PROPOSER_GONE[v].mid.join('\n')) red.push(`${v}: a mid point moved; re-record with the why:\n${o.mid!.join('\n')}`)
    if (o.end !== PROPOSER_GONE[v].end) red.push(`${v}: the end state moved — the three must be writable again; re-record with the why: ${o.end}`)
  }
  assert.deepEqual(red, [])
})

test('leave harness, explorer: 300 seeded random schedules (2001..2300) over real Nodes with the quiet-point split check — never two views at one epoch, never two nodes writable in different views once every frame has landed', () => {
  const bad: string[] = []
  for (let seed = 2001; seed <= 2300; seed++) { const o = exploreQuiet(seed); if (o.bad) bad.push(`seed ${seed} n=${o.n}: ${o.bad}`) }
  assert.deepEqual(bad, [])
})
