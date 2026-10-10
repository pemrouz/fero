//! Tier-2 SAFETY sweeps for the graceful leave (V4-6) on today's kernel (2026-10-08, the I-20 salvage; the knock
// window, DESIGN-LEAVE §10.7, 2026-10-10). Three seeded families of clean-stop schedules, each run to a bounded horizon
// with the per-event monitors on. Two claims per schedule, kept apart on purpose:
//   SAFETY  — ASSERTED on every schedule: the monitors stay quiet (one-view-per-epoch above all), no two nodes end
//             WRITABLE in different views at a quiet point (what the per-event monitor cannot see: a stale majority
//             writable at a lower epoch beside the view without it), and the data converged.
//   LIVENESS — RECORDED, not asserted: every survivor (and every leaver that came back from its dir) ends in ONE
//             view holding exactly them, writable. Today's kernel is not live on every schedule (I-20: a survivor
//             stalled PAST the knock window, a pair cut apart inside it), so the exact set of seeds it is NOT live on is
//             pinned per family. A schedule that wedges where it used to heal goes red; one that heals where it
//             used to wedge goes red too, so the pin is kept honest in both directions.
// Family 1 (`schedule`): n in 2..5, one to three leavers at once (the lowest member among them or not, staggered or
// together), slow links, a survivor STALLED across the old four-tick bound (its process paused, sim.pause: frames pile
// up in its socket, it reads them all at the wake — a long GC pause, a swap-in), leavers that keep running after their
// leave ended (the shell tears a node down on `left`; the sim keeps it until the scenario destroys it), and a newcomer
// joining a survivor in the middle of it. Run three ways: the stalls as drawn (250-700 ms) at the default 16-tick
// window; the stalls TRIPLED (750-2100 ms) at the default window, where every stall but the shortest outlasts the
// window and the survivor wakes to a leaver that is gone — the class the window does not cover; and the tripled stalls
// at a 64-tick window (3.2 s), where they are inside it again.
// Family 2 (`schedule2`): random CUTS and heals between any pair during the leave window, on a durable cluster, and
// leavers that time out and are RESTARTED FROM THEIR DIRS while the view without them may hold. Run at the default
// window and at 64 ticks: a longer window does not heal a cut.
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
// Bounded: the five sweeps and family 3 together run in about 12 s at low priority on the idle WSL2 box (100 × 5 + 40
// schedules; measured 2.1 + 1.7 + 1.9 + 2.5 + 2.8 + 1.3 s on 2026-10-10), about 30 s when it is loaded. The tails after
// the last leaver goes — 7 s and 9 s of virtual time — are kept, so a heal through the eviction chain still counts as
// live. The generators and runners live in sim/leave-sweep.ts (a plain module, so a scratch script can import them to
// run more seeds, or re-derive the known-not-live sets when the kernel's liveness changes on purpose, without running
// this sweep as a side effect).

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

//! family 1 with the knock window (2026-10-10): live on 100 of 100 at the default window. Before the window the kernel
// wedged 36 of 100 under the old stall model (a constant delay on every link of the stalled node: [1, 2, 8, 9, 13, 15,
// 20, 21, 26, 27, 31, 34, 35, 38, 40, 42, 44, 46, 50, 57, 60, 61, 65, 66, 67, 71, 74, 75, 78, 81, 85, 87, 88, 90, 92,
// 95]) and 25 under this one (a pause; the eleven that differ — 2, 20, 31, 34, 35, 50, 60, 65, 74, 78, 87 — are
// schedules where the stalled node was not the proposer and its vote still landed inside the proposal's age once it
// woke, which the delay model never let happen: it charged every answer the stall again). Every one of the 25 is
// I-20's shape — a survivor stalled across the four-tick bound wakes to a leaver that is gone — and every one is live
// now: the leaver is still there when the survivor wakes.
const KNOWN_NOT_LIVE_1 = new Set<number>([])
//! the same 100 schedules with the stalls TRIPLED (750/900/1350/2100 ms) against the default 800 ms window: the
// 750 ms stalls (and every schedule without a stalled survivor) are live; the 22 longer ones are not — the survivor
// wakes after the leaver gave up, sits `minority` in the old view, and nothing can vote the leaver out. The class the
// window does not cover (STATUS I-20: a survivor stalled past the window). Pinned exactly.
const KNOWN_NOT_LIVE_1_PAST_WINDOW = new Set<number>([1, 2, 8, 9, 15, 20, 21, 26, 27, 38, 40, 42, 44, 57, 61, 66, 67, 71, 81, 88, 92, 95])
//! family 2 with the knock window: the seeds it is NOT live on inside 1..100 (10 of 100; 13 before the window — 4, 44
// and 89 are live now: a leaver cut from the proposer but linked to another member kept knocking until the cut healed
// inside the window, and the knock then reached the lowest live member). The ten left: two-member pairs cut apart
// inside the window with no third member to keep knocking at — the knock or the answer dies with the link and the
// leaver is gone before it heals; a three-member view with the survivor cut from a leaver whose vote it needs; and a
// leaver restarted from its dir that cannot rejoin a survivor left read-only. A 64-tick window changes none of them
// (a longer window does not heal a cut). Pinned exactly; the sweep is red if the set moves either way.
const KNOWN_NOT_LIVE_2 = new Set<number>([13, 15, 31, 35, 48, 56, 70, 75, 87, 94])

test('leave sweep, family 1: 100 seeded clean-stop schedules — n 2..5, up to three leavers at once, slow links, a stalled survivor, lingering leavers, a join mid-leave — SAFE on every one; live on every one at the default knock window (the not-live set is exactly the pinned one: empty)', () => {
  sweep(100, schedule, run, shape1, KNOWN_NOT_LIVE_1)
})

test('leave sweep, family 1 past the window: the same schedules with the stalls tripled — SAFE on every one; a survivor stalled longer than the 16-tick window still wedges, on exactly the pinned seeds; at a 64-tick window every one is live again', () => {
  sweep(100, schedule, (s) => run(s, 12000, { stall: 3 }), shape1, KNOWN_NOT_LIVE_1_PAST_WINDOW)
  sweep(100, schedule, (s) => run(s, 12000, { stall: 3, tune: { leaveWindow: 64 } }), shape1, new Set<number>([]))
})

test('leave sweep, family 2: 100 seeded clean-stop schedules with cuts between pairs and leavers restarted from their dirs — SAFE on every one; the not-live set is exactly the pinned one, at the default window and at 64 ticks alike', () => {
  sweep(100, schedule2, run2, shape2, KNOWN_NOT_LIVE_2)
  sweep(100, schedule2, (s) => run2(s, 30000, { tune: { leaveWindow: 64 } }), shape2, KNOWN_NOT_LIVE_2)
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
