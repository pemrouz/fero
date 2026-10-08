//! Tier-2 SAFETY sweeps for the graceful leave (V4-6) on today's kernel (2026-10-08, the I-20 salvage). Three
// seeded families of clean-stop schedules, each run to a bounded horizon with the per-event monitors on. Two
// claims per schedule, kept apart on purpose:
//   SAFETY  — ASSERTED on every schedule: the monitors stay quiet (one-view-per-epoch above all), no two nodes end
//             WRITABLE in different views at a quiet point (what the per-event monitor cannot see: a stale majority
//             writable at a lower epoch beside the view without it), and the data converged.
//   LIVENESS — RECORDED, not asserted: every survivor (and every leaver that came back from its dir) ends in ONE
//             view holding exactly them, writable. Today's kernel is not live on every schedule (I-20: a stalled
//             survivor, a pair cut apart inside the leave window), so the exact set of seeds it is NOT live on is
//             pinned per family. A schedule that wedges where it used to heal goes red; one that heals where it
//             used to wedge goes red too, so the pin is kept honest in both directions.
// Family 1 (`schedule`): n in 2..5, one to three leavers at once (the lowest member among them or not, staggered or
// together), slow links, a survivor STALLED across the leave window (every frame to and from it held longer than a
// leaver waits — the sim has no stall primitive, so a constant delay lifted once the leavers are gone is the stall),
// leavers that keep running after their leave timed out (the shell tears a node down on `left`; the sim keeps it
// until the scenario destroys it), and a newcomer joining a survivor in the middle of it.
// Family 2 (`schedule2`): random CUTS and heals between any pair during the leave window, on a durable cluster, and
// leavers that time out and are RESTARTED FROM THEIR DIRS while the view without them may hold.
// Family 3 (`schedule3`), safety only: the two shapes the parked I-20 drafts split on, drawn with seeded timings.
// (a) two clean stops at n=4 with the two lowest members cut apart — each opens a ballot at the same epoch and asks
// the same two leavers; vote-once must let at most one commit. (b) the restart split at n=3: the lowest member and
// one more leave; the proposer commits the view without the leavers and its VIEW dies with the links, so nobody else
// learns it; both leavers time out and come back from their dirs holding a committed view the survivor never saw.
// Liveness is not claimed here: the cuts wedge the view on purpose.
// What the sweep cannot see: the proposer-side double vote fixed on 2026-10-08 (#nextEpoch) needs a node to grant
// another proposer, lose a ballot of its own above that, and be asked to propose again, with a third voter that
// never saw the first ballot — none of these families draw that shape (measured: every family stays green with the
// fix reverted). The kernel pins in kernel/membership.test.ts and the random explorer over real Nodes in
// sim/explore.test.ts carry that rule; this file is the breadth behind V4-6.
// Bounded: the three families together run in about 6 s at low priority on the idle WSL2 box (100 + 100 + 40
// schedules; measured 1.9 + 2.8 + 1.3 s on 2026-10-08), under 20 s when it is loaded. The tails after the last leaver goes — 7 s
// and 9 s of virtual time — are kept, so a heal through the eviction chain still counts as live. The generators and runners live in sim/leave-sweep.ts (a plain module, so a scratch script
// can import them to run more seeds, or re-derive the known-not-live sets when the kernel's liveness changes on
// purpose, without running this sweep as a side effect).

import { test } from 'node:test'
import assert from 'node:assert'
import { schedule, run, shape1, schedule2, run2, shape2, schedule3, run3, shape3, unsafe } from './leave-sweep.ts'

//! sweep — run `count` seeds of a family; the safety problems are asserted empty, the not-live seeds are compared to the
// pinned set in both directions (a wedge where the kernel used to heal, or a heal where it used to wedge, is a change
// to look at — update the pin on purpose, with the why).
const sweep = <S extends { seed: number }>(count: number, gen: (seed: number) => S, go: (s: S) => string[], shape: (s: S) => string, known: Set<number>) => {
  const unsafeOnes: string[] = [], notLive: string[] = [], newlyLive: number[] = []
  for (let seed = 1; seed <= count; seed++) {
    const s = gen(seed)
    const problems = go(s)
    if (unsafe(problems)) unsafeOnes.push(`${shape(s)}: ${problems.join('; ')}`)
    else if (problems.length) { if (!known.has(seed)) notLive.push(`${shape(s)}: ${problems.join('; ')}`) }
    else if (known.has(seed)) newlyLive.push(seed)
  }
  assert.deepEqual(unsafeOnes, [], 'UNSAFE: a monitor fired, or two nodes ended writable in different views')
  assert.deepEqual(notLive, [], 'a schedule the kernel used to heal is not live now: a liveness regression, or update the pin on purpose')
  assert.deepEqual(newlyLive, [], 'a schedule known to wedge is live now: take it off the pin')
}

//! family 1 on today's kernel: the seeds it is NOT live on inside 1..100 — every one is I-20's shape: a survivor stalled
// across the leave window wakes to a leaver that is already gone, and the ballot that needs the leaver's vote never
// completes, so it sits `minority` in the old view (36 of 100; the same shape on all of them). Pinned exactly; the
// sweep is red if the set moves either way.
const KNOWN_NOT_LIVE_1 = new Set<number>([1, 2, 8, 9, 13, 15, 20, 21, 26, 27, 31, 34, 35, 38, 40, 42, 44, 46, 50, 57, 60, 61, 65, 66, 67, 71, 74, 75, 78, 81, 85, 87, 88, 90, 92, 95])
//! family 2 on today's kernel: the seeds it is NOT live on inside 1..100 (13 of 100): two-member pairs cut
// apart inside the leave window — the knock or the answer dies with the link and the leaver is gone before it heals;
// a three-member view with the survivor cut from a leaver whose vote it needs; and a leaver restarted from its dir
// that cannot rejoin a survivor left read-only (seed 4: n01 holds the view without itself, `evicted`, while n02 sits
// `minority` in that view because n03 is gone for good). Pinned exactly; the sweep is red if the set moves either way.
const KNOWN_NOT_LIVE_2 = new Set<number>([4, 13, 15, 31, 35, 44, 48, 56, 70, 75, 87, 89, 94])

test('leave sweep, family 1: 100 seeded clean-stop schedules — n 2..5, up to three leavers at once, slow links, a stalled survivor, lingering leavers, a join mid-leave — SAFE on every one; the not-live set is exactly the pinned one', () => {
  sweep(100, schedule, run, shape1, KNOWN_NOT_LIVE_1)
})

test('leave sweep, family 2: 100 seeded clean-stop schedules with cuts between pairs and leavers restarted from their dirs — SAFE on every one; the not-live set is exactly the pinned one', () => {
  sweep(100, schedule2, run2, shape2, KNOWN_NOT_LIVE_2)
})

test('leave sweep, family 3: 40 seeded shapes of the two splits the parked I-20 drafts had — two clean stops with the two lowest cut apart at n=4, the restart split at n=3 — no monitor fires and no two nodes are ever writable in different views at a quiet point', () => {
  const unsafeOnes: string[] = []
  const reached = { 'cut-apart': 0, 'restart-split': 0 }
  for (let seed = 1; seed <= 40; seed++) {
    const s = schedule3(seed)
    const problems = run3(s)
    //! a seed whose timing misses the shape (the two give-ups race; a slow knock commits the leave the normal way) proves
    // nothing either way and is not counted; at least half of each kind must reach it, or the family has no teeth
    // (measured: 18 of 20 cut-apart seeds and 20 of 20 restart-split seeds reach it inside 1..40)
    if (problems.some((p) => p.startsWith('not the shape'))) continue
    reached[s.kind]++
    if (problems.length) unsafeOnes.push(`${shape3(s)}: ${problems.join('; ')}`)
  }
  assert.deepEqual(unsafeOnes, [], 'a split')
  assert.ok(reached['cut-apart'] >= 10 && reached['restart-split'] >= 10, `too few schedules reached their shape: ${JSON.stringify(reached)}`)
})
