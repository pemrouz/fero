//! The adversarial leave harness, pinned on today's kernel (DESIGN-LEAVE §9 step 2 and §10, 2026-10-10). The
// generators are in sim/leave-harness.ts; this file runs each family over its range and pins two things apart:
//   SAFETY  — ASSERTED on every schedule: no monitor fired (one-view-per-epoch above all) and no two nodes ended
//             WRITABLE in different views at a quiet point. The base is safe on every family here.
//   LIVENESS — COUNTED, pinned exactly in both directions (a schedule the kernel used to heal that wedges now is a
//             regression; one that heals where it used to wedge means the pin is stale: update it on purpose, with
//             the why). Today's kernel is not live on every schedule (I-20), so the exact sets are the FLOOR.
// Teeth, measured on 2026-10-10 by putting the parked branch's kernel/membership.ts over a scratch copy of this tree
// (docs/DESIGN-LEAVE.md §10.8): the round-0 kernel (851796b) fails `twoLeavers` (two views at epoch 2, H1); the
// review-fix kernel (915d027) fails the two n=3 named shapes (0 of 10 live, H3); the round-1 kernel (02f65ed) fails
// the seed-157 shape (0 of 10, H7); rounds 1 and 3 fail `evictsplit`, `joinsplit`, the isolate grid (11 and 9 of
// 108 split) and the seeded isolate family (12 and 8 of 100) — H11; round 3 wedges eight more crash schedules than the
// base in the default grid and 24 more in the full one, all of them the n=3 crash twin (H12). Bounded: about 30 s at low priority on the loaded WSL2 box, half that idle;
// FERO_LEAVE_FULL=1 runs the full crash grid (576 cases, three restart delays, two seeds) and 100 seeded isolate
// schedules instead of 50.
import { test } from 'node:test'
import assert from 'node:assert'
import { evictsplit, joinsplit, twoLeavers, scheduleR, runR, shapeR, NAMED_R, namedR, GRID_I, scheduleI, runI, shapeI, gridC, runC, shapeC, exploreQuiet } from './leave-harness.ts'
import { unsafe } from './leave-sweep.ts'
import { Mesh, quietSplit } from './mesh.ts'

const FULL = process.env.FERO_LEAVE_FULL === '1'

//! pinExact — the sweep's rule (sim/leave-sweep.test.ts): safety asserted, the not-live (or not-settled) set equal to
// the pinned one in both directions
const pinExact = (label: string, actual: number[], known: Set<number>, shapes: Map<number, string>) => {
  const regressed = actual.filter((s) => !known.has(s)).map((s) => `${shapes.get(s)}`)
  const improved = [...known].filter((s) => !actual.includes(s))
  assert.deepEqual(regressed, [], `${label}: a schedule the kernel used to heal is not live now — a liveness regression, or update the pin on purpose`)
  assert.deepEqual(improved, [], `${label}: a schedule known to wedge is live now — take it off the pin`)
}

test('leave harness, pins: evictsplit and joinsplit (the round-3 report\'s two schedules) — safe on seeds 1..5, the far side settles without n01, n01 is never writable; twoLeavers (the first review\'s n=4 schedule) — safe on seeds 1..10', () => {
  const bad: string[] = []
  for (const [name, go] of [['evictsplit', evictsplit], ['joinsplit', joinsplit]] as const) {
    for (let seed = 1; seed <= 5; seed++) {
      const o = go(seed)
      if (o.problems.length) bad.push(`${name} ${seed}: ${o.problems.join('; ')}`)
      if (!o.settled) bad.push(`${name} ${seed}: the far side did not settle`)
      if (o.proposerWritable) bad.push(`${name} ${seed}: n01 writable while cut off from every member`)
    }
  }
  for (let seed = 1; seed <= 10; seed++) { const ps = twoLeavers(seed); if (ps.length) bad.push(`twoLeavers ${seed}: ${ps.join('; ')}`) }
  assert.deepEqual(bad, [])
})

//! rebirth on today's kernel: the seeds it is NOT live on inside 1..100 (22 of 100): pairs cut apart inside the leave
// window, a leaver's knock that dies with a cut and is never answered, three leavers at n=4 with the lowest among them
// under a cut. Pinned exactly.
const KNOWN_NOT_LIVE_R = new Set<number>([8, 9, 19, 25, 26, 31, 32, 33, 40, 41, 46, 47, 49, 50, 60, 61, 63, 64, 72, 82, 84, 98])

test('leave harness, rebirth: 100 seeded schedules of cuts and heals between pairs with leavers reborn as fresh identities (the round-2 report\'s sweep2) — SAFE on every one; the not-live set is exactly the pinned one; the named shapes (the reviewer\'s seed 157, the n=3 two-stop pair) heal on 10 of 10 sim seeds', () => {
  const unsafeOnes: string[] = [], notLive: number[] = [], shapes = new Map<number, string>()
  for (let seed = 1; seed <= 100; seed++) {
    const s = scheduleR(seed); const ps = runR(s)
    shapes.set(seed, `${shapeR(s)}: ${ps.join('; ')}`)
    if (unsafe(ps)) unsafeOnes.push(shapes.get(seed)!)
    else if (ps.length) notLive.push(seed)
  }
  assert.deepEqual(unsafeOnes, [], 'UNSAFE: a monitor fired, or two nodes ended writable in different views')
  pinExact('rebirth', notLive, KNOWN_NOT_LIVE_R, shapes)
  const named: string[] = []
  for (const name of Object.keys(NAMED_R)) for (let seed = 1; seed <= 10; seed++) { const ps = runR(namedR(name, seed)); if (ps.length) named.push(`${name} under sim seed ${seed}: ${ps.join('; ')}`) }
  assert.deepEqual(named, [], 'a named shape the base heals did not heal')
})

//! isolate on today's kernel: the grid's far side settles (one view without n01, writable) on 84 of 108; on the other
// 24 the far side is a two-member pair cut from a leaver whose vote it needs, or a stayer alone — the I-20 class. n01
// is writable on none (a proposer cut from every member can commit nothing). The seeded family settles on 42 of 50.
const SETTLED_GRID_I = 84
const KNOWN_NOT_SETTLED_I = new Set<number>([4, 11, 13, 21, 29, 35, 36, 39, ...(FULL ? [56, 59, 60, 61, 68, 69, 74, 79, 80, 90, 93, 97, 99] : [])])

test('leave harness, isolate grid: the 108 schedules the round-3 report counted — the proposer cut off 5/10/30 ms after one or two stops, the leavers back from their dirs 0.3/1.5/5 s later beside a stale stayer — SAFE on every one, n01 writable on none, the far side settles on exactly 84', () => {
  const unsafeOnes: string[] = [], writable: string[] = []
  let settled = 0
  GRID_I.forEach((s) => {
    const o = runI(s)
    if (unsafe(o.problems)) unsafeOnes.push(`${shapeI(s)}: ${o.problems.join('; ')}`)
    if (o.proposerWritable) writable.push(shapeI(s))
    if (o.settled) settled++
  })
  assert.deepEqual(unsafeOnes, [], 'UNSAFE: a monitor fired, or two nodes ended writable in different views')
  assert.deepEqual(writable, [], 'n01 writable while cut off from every member: a commit on votes it never received live')
  assert.equal(settled, SETTLED_GRID_I, 'the far side settled on a different number of schedules: a liveness change to look at')
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
// (DESIGN-LEAVE §7). The full grid (576) wedges on 60, the same class. Pinned exactly.
const KNOWN_NOT_LIVE_C = new Set<number>(FULL ? [] : [5, 7, 13, 15, 21, 23, 29, 31, 47, 63])

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
  if (!FULL) pinExact('crash', notLive, KNOWN_NOT_LIVE_C, shapes)
  else assert.equal(notLive.length, 60, `the full crash grid wedged on ${notLive.length}, not 60: ${notLive.map((i) => shapes.get(i)).join('\n')}`)
})

//! the check itself, pinned by hand: two members each writable alone in a solo view of its own is the split the
// one-view-per-epoch recorder cannot see (the epochs are equal, the members differ, nothing was installed twice at one
// epoch); one solo view is not. No family above ever made it fire on today's kernel, so this is its proof of teeth.
test('leave harness, the quiet-point check: two nodes writable in different views are named; one writable node is not', () => {
  const m = new Mesh()
  const aa = m.add('aa'), bb = m.add('bb')
  aa.membership.install(aa, { epoch: 1, members: [['aa', 'sim:aa']] })
  assert.equal(quietSplit(m, 0), null)
  bb.membership.install(bb, { epoch: 1, members: [['bb', 'sim:bb']] })
  assert.match(quietSplit(m, 0) ?? '', /aa@1\{aa\} bb@1\{bb\}/)
})

test('leave harness, explorer: 300 seeded random schedules over real Nodes with the quiet-point split check — never two views at one epoch, never two nodes writable in different views once every frame has landed', () => {
  const bad: string[] = []
  for (let seed = 1; seed <= 300; seed++) { const o = exploreQuiet(seed); if (o.bad) bad.push(`seed ${seed} n=${o.n}: ${o.bad}`) }
  assert.deepEqual(bad, [])
})
