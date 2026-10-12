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
// at a 64-tick window (3.2 s), where they are inside it again. A fourth run keeps the sweep's OLD stall model, a
// survivor alive but SLOW (every frame to and from it held for the stall, lifted once the leavers are gone, so each
// knock and each answer pays the stall in turn): it wedged 36 of 100 before the window and 20 with it, 1 at 64 ticks —
// repeated knocks at a slow survivor are the second shape of I-20, and the model stays so that shape stays measured.
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
// Bounded: the seven sweeps and family 3 together run in about 15 s at low priority on the idle WSL2 box (100 × 7 + 40
// schedules; measured 2.1 + 1.7 + 1.9 + 2.5 + 2.8 + 1.3 s for the first five and family 3 on 2026-10-10, the delay
// model's two about 3 s more; 16.7 s in all under some load), about 35 s when the box is loaded. The tails after
// the last leaver goes — 7 s and 9 s of virtual time — are kept, so a heal through the eviction chain still counts as
// live. The generators and runners live in sim/leave-sweep.ts (a plain module, so a scratch script can import them to
// run more seeds, or re-derive the known-not-live sets when the kernel's liveness changes on purpose, without running
// this sweep as a side effect).

import { test } from 'node:test'
import assert from 'node:assert'
import { schedule, run, shape1, schedule2, run2, shape2, schedule3, run3, shape3, unsafe, starved } from './leave-sweep.ts'

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
// wedged 36 of 100 under the delay model (the sweep's stall model then: a constant delay on every link of the stalled
// node: [1, 2, 8, 9, 13, 15, 20, 21, 26, 27, 31, 34, 35, 38, 40, 42, 44, 46, 50, 57, 60, 61, 65, 66, 67, 71, 74, 75,
// 78, 81, 85, 87, 88, 90, 92, 95]) and 25 under this one (a pause: [1, 8, 9, 13, 15, 21, 26, 27, 38, 40, 42, 44, 46,
// 57, 61, 66, 67, 71, 75, 81, 85, 88, 90, 92, 95]; the eleven that differ — 2, 20, 31, 34, 35, 50, 60, 65, 74, 78, 87 —
// are schedules where the stalled node was not the proposer and its vote still landed inside the proposal's age once
// it woke, where under a delay each answer paid the stall again). Every one of the 25 is I-20's shape — a survivor
// stalled across the four-tick bound wakes to a leaver that is gone — and every one is live now: the leaver is still
// there when the survivor wakes. The like-for-like before-and-after is 25 → 0 (the pause); 36 is the delay model's.
const KNOWN_NOT_LIVE_1 = new Set<number>([])
//! the same 100 schedules under the DELAY model (the sweep's stall before the window: the survivor alive but slow,
// every frame held for the stall and the hold lifted once the leavers are gone), at the default window: 20 not live,
// down from the 36 the base kernel wedged under it. The sixteen that went live are schedules where the late answers
// still landed while the leaver knocked on; the twenty left are the stall paid too many times over for 800 ms — four
// stalls per round trip — so the leaver gave up first. At 64 ticks (3.2 s) one is left, seed 42: n=4, three leavers,
// the one survivor slow by 700 ms each way, so three leaves in turn at four stalls a round trip outlast 3.2 s and the
// last leaver goes with the survivor sitting in a two-member view it cannot shrink; it wedges the same with the hold
// never lifted (the lift comes only once every leaver is gone), and is live at a 200-tick window. Pinned exactly, both.
const KNOWN_NOT_LIVE_1_DELAY = new Set<number>([8, 9, 15, 20, 21, 26, 27, 38, 40, 42, 44, 57, 66, 67, 71, 75, 81, 88, 92, 95])
const KNOWN_NOT_LIVE_1_DELAY_64 = new Set<number>([42])
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
// leaver restarted from its dir that cannot rejoin a survivor left read-only. Pinned exactly; the sweep is red if the set
// moves either way. At a 64-tick window the set used to be the same (a longer window does not heal a cut); since
// 2026-10-12 (wave 6b, the eviction rides with the leave, kernel/membership.ts #leaveView) a longer window heals 15 and
// 56 — 8 of 100 at 64 ticks. Both are the "survivor cut from a leaver whose vote it needs" shape: n=3, n02 and n03
// leaving, n02 cut from the proposer n01, so n01's ballot for n03's leave, {n01,n02}@2, needed n02's vote, and n02 could
// neither hear nor answer; n02 went at its bound and was torn down. n02 is a suspect at n01 three ticks after the cut and
// its chain gives up about 900 ms after it; the ballot in flight is then re-read without n02 — {n01}@2 — and n03's grant
// commits it, n03 leaves cleanly and n01 ends alone, writable. At the default window n03's own window has ended by then
// (its leave began at 120 ms; the chain gives up past 970), so the two stay not live there, as on the base, where n01 sat
// `minority` in a view with two dead members for good under any window. The eight left are the pair cuts and the
// restarted leaver beside a read-only survivor, which no window heals.
const KNOWN_NOT_LIVE_2 = new Set<number>([13, 15, 31, 35, 48, 56, 70, 75, 87, 94])
const KNOWN_NOT_LIVE_2_64 = new Set<number>([13, 31, 35, 48, 70, 75, 87, 94])

test('leave sweep, family 1: 100 seeded clean-stop schedules — n 2..5, up to three leavers at once, slow links, a stalled survivor, lingering leavers, a join mid-leave — SAFE on every one; live on every one at the default knock window (the not-live set is exactly the pinned one: empty)', () => {
  sweep(100, schedule, run, shape1, KNOWN_NOT_LIVE_1)
})

test('leave sweep, family 1 past the window: the same schedules with the stalls tripled — SAFE on every one; a survivor stalled longer than the 16-tick window still wedges, on exactly the pinned seeds; at a 64-tick window every one is live again', () => {
  sweep(100, schedule, (s) => run(s, 12000, { stall: 3 }), shape1, KNOWN_NOT_LIVE_1_PAST_WINDOW)
  sweep(100, schedule, (s) => run(s, 12000, { stall: 3, tune: { leaveWindow: 64 } }), shape1, new Set<number>([]))
})

test('leave sweep, family 1 under the delay model: the same schedules with the survivor alive but SLOW (every frame held for the stall) — SAFE on every one; the not-live set is exactly the pinned one at the default window (20; 36 before the window) and at 64 ticks (seed 42)', () => {
  sweep(100, schedule, (s) => run(s, 12000, { model: 'delay' }), shape1, KNOWN_NOT_LIVE_1_DELAY)
  sweep(100, schedule, (s) => run(s, 12000, { model: 'delay', tune: { leaveWindow: 64 } }), shape1, KNOWN_NOT_LIVE_1_DELAY_64)
})

test('leave sweep, family 2: 100 seeded clean-stop schedules with cuts between pairs and leavers restarted from their dirs — SAFE on every one; the not-live set is exactly the pinned one at the default window (10), and at 64 ticks two fewer (15 and 56: the leave ballot re-read without the cut-off leaver once its chain gives up, while the other leaver still knocks)', () => {
  sweep(100, schedule2, run2, shape2, KNOWN_NOT_LIVE_2)
  sweep(100, schedule2, (s) => run2(s, 30000, { tune: { leaveWindow: 64 } }), shape2, KNOWN_NOT_LIVE_2_64)
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

//! the knock starvation (wave 6b, 2026-10-12; DESIGN-LEAVE §10.7's note, STATUS's line "A LEAVE knock reopens an aged-out
// leave ballot ahead of an evictable suspect"): three members, n03 crashed and not yet voted out, a second member stops.
// Pinned on the base first — `left` b=0 at exactly the window's end, 200 / 800 / 3200 ms after the stop, with n01 proposing
// the same doomed ballot P(2,2) = {n01,n03} again at every age-out and never the eviction — then re-recorded under THE
// EVICTION RIDES WITH THE LEAVE: the moment n03's chain gives up the ballot is re-read as P(2,1) = the stayer alone, one
// round trip commits it, and the stop is clean inside the default window (about 510 ms after the stop; a 4-tick window
// still ends before the chain does, which is what a window shorter than the redial chain must do — the README no longer
// tells the operator to wait for the eviction). With the cut 800 ms before the stop the tick's eviction had already run
// and the stop is clean in a tick, both kernels: P(2,2) the eviction, P(3,1) the leave.
test('the knock starvation: n=3 at heartbeat 50, n03 cut 200 ms before the stop — whichever member stops (n02, or n01 the lowest), the eviction of n03 runs first and the stop is CLEAN inside the default 16-tick window and at 64 (the base went unclean at the window\'s end); at a 4-tick window the chain outlasts the window, unclean at 200 ms as before; cut 800 ms before, clean in a tick', () => {
  for (const leaver of ['n02', 'n01'] as const) {
    for (const w of [16, 64]) {
      const r = starved(leaver, 200, w)
      assert.equal(r.left, true, `${leaver} at ${w} ticks: ${JSON.stringify(r)}`)
      assert.ok(r.afterStop > 300 && r.afterStop < 800, `${leaver} at ${w} ticks: clean once n03's chain gave up, inside the default window — ${JSON.stringify(r)}`)
      assert.equal(r.ballots, 'P(1,3) P(2,2) P(2,1)', `${leaver} at ${w} ticks: the plain leave ballot, then — the chain given up — the same ballot re-read without n03, at the same epoch — ${JSON.stringify(r)}`)
      assert.match(r.stayer, /@2\{n0[12]\}$/, `${leaver} at ${w} ticks: the stayer alone at 2 — ${r.stayer}`)
    }
    const short = starved(leaver, 200, 4)
    assert.deepEqual([short.left, short.afterStop], [false, 200], `${leaver} at 4 ticks: the window ends before the chain gives up — ${JSON.stringify(short)}`)
    const given = starved(leaver, 800, 16)
    assert.equal(given.left, true, `${leaver}, n03 given up before the stop: ${JSON.stringify(given)}`)
    assert.ok(given.afterStop <= 50, `${leaver}: clean in a tick — ${JSON.stringify(given)}`)
    assert.equal(given.ballots, 'P(1,3) P(2,2) P(3,1)', `${leaver}: the tick's eviction had already run; the leave is the next ballot, as on the base — ${JSON.stringify(given)}`)
  }
})

//! THE DROP IS STICKY (the first review of wave 6b, DESIGN-LEAVE §10.7's amendment of 2026-10-12): the same shape on a SLOW
// link — a one-way delay of 30 or 40 ms on the 50 ms heartbeat, so the vote's round trip (60 / 80 ms) is longer than a
// heartbeat. As first built the re-read oscillated with the heartbeat's give-up revival: the tick dropped n03 from the
// ballot, the same step's revival re-armed n03's chain, the next tick read n03 as dialing again and re-proposed the plain
// ballot, discarding the vote in flight — `P(2,2) P(2,1) P(2,2) P(2,1) …` and `left` b=0 at the window's end (800 / 3200
// ms) at 16 and 64 ticks alike, for either leaver, exactly like the base. Now the re-read starts from the ballot in flight
// and only ever removes: ONE re-read, kept while the vote round-trips. The ballots read `P(1,3) P(2,2) P(2,2) P(2,1)`: the
// first plain ballot ages out (proposalAge, 10 ticks) before the slower chain gives up — a failed dial to a cut peer pays
// the link's delay in the sim (sim/exec.ts connect), so the five-dial chain gives up 150 / 200 ms later than at 3 ms — the
// re-knock reopens it, then the give-up's re-read drops n03 once. Measured, after the stop: delay 30 → n02 clean at 790 ms,
// n01 at 820; delay 40 → n02 at 870, n01 at 910. At 64 ticks every one is clean; at 16 ticks the window ends at 800 ms, so
// only n02 at delay 30 is inside it and the other three go unclean AT the window's end with the same four ballots and no
// oscillation — the window-shorter-than-the-chain class the note names, not the flip. Pinned: the verdicts at 64 ticks, and
// the ballot string at both windows (nothing after the one `P(2,1)`).
test('the knock starvation on a slow link (the drop is sticky): n=3 at heartbeat 50 with every link 30 or 40 ms one way (a vote slower than a heartbeat), n03 cut 200 ms before the stop — whichever member stops, the re-read drops n03 ONCE and the ballot is kept while the vote round-trips: clean at 64 ticks for both delays and both leavers; at 16 ticks the same four ballots and no oscillation, the verdict decided by the window alone', () => {
  for (const leaver of ['n02', 'n01'] as const) {
    for (const delay of [30, 40]) {
      const r = starved(leaver, 200, 64, delay)
      assert.equal(r.left, true, `${leaver} at 64 ticks, delay ${delay}: ${JSON.stringify(r)}`)
      assert.ok(r.afterStop > 700 && r.afterStop < 1000, `${leaver} at 64 ticks, delay ${delay}: clean once the chain gave up and the vote round-tripped — ${JSON.stringify(r)}`)
      assert.equal(r.ballots, 'P(1,3) P(2,2) P(2,2) P(2,1)', `${leaver} at 64 ticks, delay ${delay}: the plain ballot, aged out and reopened, then dropped once and KEPT — ${JSON.stringify(r)}`)
      assert.match(r.stayer, /@2\{n0[12]\}$/, `${leaver} at 64 ticks, delay ${delay}: the stayer alone at 2 — ${r.stayer}`)
      const w16 = starved(leaver, 200, 16, delay)
      assert.equal(w16.ballots, 'P(1,3) P(2,2) P(2,2) P(2,1)', `${leaver} at 16 ticks, delay ${delay}: no oscillation — the same four ballots, nothing after the one re-read — ${JSON.stringify(w16)}`)
      assert.equal(w16.left, w16.afterStop < 800, `${leaver} at 16 ticks, delay ${delay}: the window alone decides (unclean exactly at its end, 800 ms) — ${JSON.stringify(w16)}`)
    }
  }
})
