# E-22: the API on five kernel operations, under faults, the shuffle and outside checkers

**Question (Q-22).** Does the proposed API ([API.md](../../API.md)) cover every pattern on the kernel's five operations, and which patterns need atomicity across partitions, or methods at the writer? This is the experiment's report. Three agents built it in three steps:
- step 1 built the prototype core and measured TEST-01 ([STEP1.md](STEP1.md), [PROTO.md](PROTO.md));
- step 2 wrote all 22 patterns as examples with checks and built the L5 libraries ([patterns/README.md](patterns/README.md));
- step 3 (this file and [verify/](verify)) ran every check with a leader change and a slot move injected during it, and again under 100 seeds of the shuffle; recorded client histories; checked them with Porcupine and Elle; fixed what that found; and gives the verdict.

[API-NOTES.md](API-NOTES.md) is the list of API changes (parts C, D and F) and of prototype bugs found (parts E and G).

**Words.** A *partition* is the unit of order (by default one row). A *slot* is one of 1,024 buckets a partition hashes to; a *slot move* takes a slot to another group. A *group* is one log with one *writer* (its leader). A *leader change* here is an election that may drop the old leader's uncommitted tail. The *shuffle* (TEST-12) delivers different partitions in a seeded random order. A *seed* fixes every random choice of a run, so it replays exactly. *Linearizable* means every operation seems to happen at one instant between its call and its answer. *Porcupine* checks that from a history; *Elle* finds cycles between transactions in a history (G0: two units write in opposite orders; G-single: a reader sees half a unit). A *fence token* is the number a lock holder carries on its writes, so a writer can refuse an older holder.

## In short

- **All 22 patterns run on the five kernel operations, and no pattern needed a sixth.** Every fix found below is a rule in L2, L4 or L5. (measured here: [verify/results/matrix.md](verify/results/matrix.md))
- **With a leader change and a slot move forced into the work of every seed, the pattern checks pass in 100 of 100 seeds,** with and without the shuffle, except two check expectations explained below (P-10: 1 and 2 seeds; P-11: 7 and 1 seeds) that are not safety failures. A leader change landed while a client operation on the same resource was in flight in 80 to 100 of 100 seeds per check, and a slot move in 97 to 100. (measured here)
- **Porcupine found every one of 183,159 per-partition histories linearizable** (1.5 million operations: writes with conditions and ops, claims, touches, fresh reads), after one fix. Before it, Porcupine found one history that was not, and it was a real design gap: **a refusal answered from the writer's uncommitted tail** (F1). A planted race showed the worst case: in 10 of 100 seeds a check-then-set was refused because of a write that was then lost. Fix: a refusal waits for the commit of what it was judged on. (measured here)
- **Elle found write cycles between saga units (G0) in 10 to 19 of 100 histories** when a holder died or paused mid-saga: the saga as API.md describes it did not meet P-15's MUST as REQUIREMENTS checks it. Two L5 rules (locks belong to the unit until it ends, Percolator-style) took G0 to 0 of 300 histories. Fractured reads (G-single) stay in 66 to 77 of 100, as API.md says: atomic visibility is P-15's SHOULD, not built. (measured here)
- **The faults found two more bugs and two more gaps**: a row bound to a session can outlive it forever if the process dies before its session record commits (P-13: 19 of 100 seeds; fixed: a bound write waits for its session); a saga cannot undo `push`, `merge`, `max` or `min` (it deletes the key); a lock's protected write can still land between a new grant and the new holder's first write; and a bug in the simulated election (fixed). (measured here)
- **Nothing is safe only at the writer.** The condition and op forms of check-then-set held in all 300 races under forced faults and the shuffle, wherever the calls ran; the plain form failed everywhere (step 2). So U `any` stands.
- **TEST-12 has teeth:** a planted app that reads a pointer row and then its target failed in 25 of 100 shuffled seeds and never without the shuffle; no pattern example passed only without it.
- **TEST-01 holds** after all the fixes: a fresh node plus a scenario takes 0.14 ms at the median and 3.6 ms at p99 (bar 5 ms); 200 chaos seeds take 0.65 s (bar 1 s). (measured here, timing lock, 3 runs)
- **The checkers have teeth.** Both passed a self-test on 26 known histories, 18 of them known-bad. Two planted kernel bugs (a writer that forgets its attempts; an election that loses a committed write) were caught in all eight runs: by the direct checks, by Porcupine (4 to 28 seeds per check), or as a client left waiting forever, often where the check's own assertions passed. (measured here)

## The per-pattern table

100 seeds per cell; P-18's cell also counts 200 TEST-02 worlds. *calm*: shuffle off, no random leader changes or moves. *faults*: the check's own faults plus one forced leader change and one forced slot move aimed at a write in flight; shuffle off. *shuffle*: the same with TEST-12's shuffle on. *In flight*: seeds of the shuffle run where a leader change, or a slot move, overlapped a client operation on the same resource. *Porcupine*: per-partition histories of all three modes. *Direct*: seven exact checks on every seed (method below). *Lines*: the example's lines (bar 40). All measured here after the fixes in [API-NOTES.md](API-NOTES.md) part G; the run before them is in [verify/results/before-fixes/](verify/results/before-fixes).

| id | pattern | lines | calm | faults | shuffle | in flight: leader change, move | Porcupine: linearizable partitions | direct | notes |
|---|---|---|---|---|---|---|---|---|---|
| P-01 | live shared state | 21 | 100 | 100 | 100 | 100, 100 | 600 of 600 | clean | |
| P-02 | cache, sessions | 14 | 100 | 100 | 100 | 100, 100 | 12,900 of 12,900 | clean | expiry late by one election when its writer fails over (step 2, D9) |
| P-03 | near cache | 14 | 100 | 100 | 100 | 100, 100 | 18,000 of 18,000 | clean | |
| P-04 | read-through | 15 | 100 | 100 | 100 | 100, 100 | 300 of 300 | clean | |
| P-05 | rooms | 22 | 100 | 100 | 100 | 100, 100 | 900 of 900 | clean | |
| P-06 | pub/sub | 16 | 100 | 100 | 100 | 100, 100 | stream only | clean | |
| P-07 | streams, replay | 18 | 100 | 100 | 100 | 99, 100 | stream only | clean | |
| P-08 | consumer groups | 24 | 100 | 100 | 100 | 98, 100 | 51,000 of 51,000 | clean | |
| P-09 | work queue | 12 | 100 | 100 | 100 | 96, 100 | 600 of 600 | clean | |
| P-10 | locks, election | 18 | 100 | 99 | 98 | 99, 100 | 897 of 897 | clean | 2 check expectations, not safety (F5) |
| P-11 | counters, limits | 13 | 100 | 93 | 99 | 100, 100 | 900 of 900 | clean | a check artifact (below) |
| P-12 | leaderboards | 24 | 100 | 100 | 100 | 100, 100 | 9,000 of 9,000 | clean | |
| P-13 | presence | 11 | 100 | 100 | 100 | 100, 100 | 2,100 of 2,100 | clean | 81 and 88 before fix G2 (F2) |
| P-14 | invariants | 18 | 100 | 100 | 100 | 100, 100 | 1,200 of 1,200 | clean | plus the phantom-conflict check: 90 before fix G1, 100 after (F1) |
| P-15 | sagas | 11 | 100 | 100 | 100 | 99, 98 | 3,000 of 3,000 | clean | Elle: G0 without F3's rules; see below |
| P-16 | event sourcing | 18 | 100 | 100 | 100 | 100, 100 | stream only | clean | |
| P-17 | derived resources | 10 | 100 | 100 | 100 | 98, 99 | 36,000 of 36,000 | clean | |
| P-18 | tapes (fork not built) | 25 | 300 | 300 | 300 | 100, 100 of the 100 harness worlds | 1,500 of 1,500 | clean | TEST-06 fork open |
| P-19 | clients everywhere | 11 | 100 | 100 | 100 | 100, 100 | 1,500 of 1,500 | clean | no transport or bundle (simulation) |
| P-20 | shape change | 21 | 100 | 100 | 100 | 92, 100 | 6,300 of 6,300 | clean | 90 and 95 before fix G3 (a simulation bug) |
| P-21 | request, reply | 16 | 100 | 100 | 100 | 96, 99 | 4,662 of 4,662 | clean | |
| P-22 | delayed jobs | 16 | 100 | 100 | 100 | 100, 100 | 900 of 900 | clean | |
| Q-22 | check-then-set race | — | 100 | 100 | 100 | 100, 100 | 1,800 of 1,800 | clean | conditions and ops: never two sales |
| core | exactly once | — | 100 | 100 | 100 | 100, 100 | 1,200 of 1,200 | clean | |
| core | log reader cursors | — | 100 | 100 | 100 | 100, 100 | log only | clean | |
| core | feature checks | — | 100 | 100 | 100 | 100, 100 | 17,400 of 17,400 | clean | |
| TEST-02 | determinism | — | ok | ok | ok | 200, 200 of 200 | 1,800 of 1,800 | clean | each seed twice: identical |
| TEST-13 | register workload | — | 100 | 100 | 100 | 100, 100 | 1,800 of 1,800 | clean | 1 not linearizable before fix G1 |
| TEST-12 | planted app, 2 partitions | — | 100 | 100 | **75** | 100, 100 | 6,300 of 6,300 | clean | fails only under the shuffle, as it should |
| TEST-12 | same app, 1 partition | — | 100 | 100 | 100 | 100, 100 | 300 of 300 | clean | |

"Stream only" and "log only": these patterns write `rows: false` streams or read the log; their writes still pass the direct checks (exactly once, acked, kept), and their order is checked by their own checks.

**Faults that hit** (all checks, 3,400 worlds per mode; measured here): faults mode 7,792 elections, 1,630 uncommitted tail entries lost, 5,977 of 5,988 slot moves finished, 976 resends answered from the writer's attempt table; shuffle mode 7,765, 1,451, 5,994 of 6,000 and 1,031. The forced pair landed in 3,082 and 3,099 worlds (the rest are worlds with no fault window: TEST-02's own worlds and the phantom race, which schedules its own).

**The four cells under 100, all explained (measured here, traced seed by seed):**
- **P-11 (7 and 1 seeds):** the check asserts "a refused take appends nothing" by counting the entries *appended* to the limiter's logs. A forced leader change during the limiter's burst makes the new leader append a no-op and re-append the lost tail, so the count rises with no refused take committing. The direct `refusal` check (no refused write ever commits) and Porcupine (each refusal legal in its state) are clean in every seed. A check artifact; counting committed writes fixes it.
- **P-10, seed 33 (faults and shuffle):** two `#locks` elections inside the 15 s pause each extended the lease by one `election.ms` (D10's rule), so the paused holder was still the holder when it woke. One holder at a time.
- **P-10, seed 68 (shuffle):** the other process took the lock, and the old holder's write under the old token still committed, because the ledger's writer had not yet folded the new `#locks` row. It landed before the new holder's first protected write, so tokens never went back in the ledger's log: both fencing checks are clean. What holds is API.md's own words, "older than one *that writer has seen*"; the check expected more (F5).
- **The planted app (25 of 100 under the shuffle):** this one must fail; it is TEST-12's teeth.

## What the outside checkers found

**Porcupine** (per partition, all modes; [verify/results/porcupine.jsonl](verify/results/porcupine.jsonl)):

| | partitions | operations | not linearizable | timed out |
|---|---|---|---|---|
| before the fixes | 182,838 | 1,502,557 | 1 (`lin-kv` calm seed 77) | 0 |
| after the fixes | 183,159 | 1,504,350 (532,255 writes, 468,902 claims, 397,113 touches, 64,806 fresh reads, 41,274 log entries) | 0 | 0 |

The one history before the fixes: a check-then-set refused `conflict` because an incr sat in the writer's uncommitted tail; a fresh read that started after the refusal still saw the version the refused write had asked for. No order of the operations explains both answers. [verify/phantom.check.ts](verify/phantom.check.ts) then forces the race (an incr whose client dies, a check-then-set, a leader change): 10 of 100 seeds refused a write because of an incr that was then lost (a *phantom conflict*). After G1 (a refusal waits for the commit of the log end it was judged on): 0 of 100, and Porcupine finds nothing in 300 more seeds of it. ([verify/results/phantom-before.txt](verify/results/phantom-before.txt), [phantom-after.txt](verify/results/phantom-after.txt))

**Elle** (list-append, the P-15 workload, 100 histories per row; [verify/results/elle.txt](verify/results/elle.txt)):

Read committed valid = no G0, G1a, G1b, G1c, lost or doubled element (P-15's MUST). Serializable valid adds no G-single or G2 (needed for its SHOULD).

| variant | mode | histories | read committed valid | serializable valid | anomalies (histories with it: total cases) |
|---|---|---|---|---|---|
| saga | calm | 100 | 84 | 29 | G-nonadjacent 2: 2, G-single 71: 96, G0 16: 16 |
| saga | faults | 100 | 81 | 39 | G-nonadjacent 5: 5, G-single 61: 87, G0 19: 19 |
| saga | shuffle | 100 | 90 | 20 | G-nonadjacent 10: 10, G-single 80: 128, G0 10: 10 |
| owned | calm | 100 | 100 | 28 | G-nonadjacent 5: 5, G-single 72: 96 |
| owned | faults | 100 | 100 | 34 | G-nonadjacent 4: 4, G-single 66: 93 |
| owned | shuffle | 100 | 100 | 23 | G-nonadjacent 6: 6, G-single 77: 121 |
| undo | calm | 100 | 12 | 3 | G-nonadjacent 72: 72, G-single 63: 64, G0 1: 1, G1a 46: 451, incompatible-order 87: 194 |
| undo | faults | 100 | 19 | 8 | G-nonadjacent 65: 65, G-single 60: 60, G0 2: 2, G1a 39: 304, incompatible-order 79: 165 |
| undo | shuffle | 100 | 8 | 4 | G-nonadjacent 54: 54, G-single 61: 66, G0 2: 2, G1a 72: 598, incompatible-order 86: 205 |
| nolock | calm | 100 | 0 | 0 | G-nonadjacent 93: 112, G-single 100: 200, G0 95: 138, duplicate-elements 100: 571 |
| nolock | faults | 100 | 0 | 0 | G-nonadjacent 93: 109, G-single 100: 186, G0 95: 131, duplicate-elements 100: 564 |
| nolock | shuffle | 100 | 0 | 0 | G-nonadjacent 94: 104, G-single 100: 191, G0 92: 134, duplicate-elements 100: 557 |

- **saga** (step 2's library, as API.md describes it): no unit is half applied (the direct check passes in every seed), but G0 appears: unit A's holder dies after A's first step; A's partition locks lapse with its lease; unit B takes them and writes the same rows; a recoverer finishes A later. A is before B on one row and after B on another. A paused holder adds a second way: its steps were fenced by the saga's own lock, not by the partition's lock, so it kept writing where it had lost the lock.
- **owned** ([verify/saga-owned.ts](verify/saga-owned.ts): step 2's saga plus two rules): each step is fenced by its partition's lock; a saga marks its intent `locked` before its first step; a saga that finds another's unfinished `locked` intent on its partitions finishes or undoes it first. G0 goes to 0. An earlier version with rule 2 alone (resolve only a unit whose own lock is free) took G0 from 16 to 6 in 100 (calm; measured once while building, not kept as a file), which is how the second way in was found.
- **G-single** (a reader saw half a unit) stays in every saga variant: P-15's SHOULD (atomic visibility) is not built, as API.md Q-A10 says. **G-nonadjacent** is a cycle of the same kind with more readers.
- **undo** (every third unit's last step fails, so the saga undoes): lists lose elements (incompatible order) and readers saw undone appends (G1a). The saga undoes a `push` by removing the key (F4).
- **nolock** (a planted bad app: no saga): G0 and duplicates in every history, as expected.

**Direct checks** (every seed of every check and mode): `once` (no attempt commits twice), `refusal` (a refused write never commits later), `acked` (every acknowledged write is in the log with its version), `kept` (no committed entry is lost), `fence-log` (TEST-13's fencing checker, per log), `fence-rt` (no fenced write acknowledged if it started after a newer token's write was acknowledged), `session` (a process's reads never go back and see its own writes). All zero in every cell after the fixes, and before them.

**Mutants: the checkers catch planted bugs** ([verify/results/mutants.txt](verify/results/mutants.txt); 100 seeds each, shuffle mode):

| mutant | check | the check's own assertions | direct checks | Porcupine: partitions not linearizable |
|---|---|---|---|---|
| `nodedup`: each writer forgets its attempts, so a resend applies twice | register workload | pass (it asserts nothing itself) | once 25, refusal 35 | 18 of 600, in 17 of 100 seeds |
| | core exactly-once | fail, 28 of 100 seeds | once 34 | 33 of 400, in 28 seeds |
| | P-11 | fail, 21 of 100 | once 21 | 20 of 280, in 20 seeds |
| | P-14 | pass | once 1 | 0 of 400 (the one doubled write was never read back) |
| `lostcommit`: each election drops the newest committed write | register workload | hangs at seed 7 (a client waits forever for its lost write) | kept 20, once 1 | 6 of 36, in 4 of the 6 seeds before the hang |
| | core exactly-once | hangs at seed 1 | (no seed finished) | (no seed finished) |
| | P-11 | hangs at seed 30 | kept 22, once 1 | 10 of 84, in 10 of 29 seeds |
| | P-14 | fail, 91 of 100 | kept 214 | 6 of 400, in 6 seeds |

`refusal` under `nodedup`: a resend judged afresh was refused `conflict` although its first copy had committed. A hang is reported as a failed seed: the world went idle with a client still waiting.

**Self-test** ([verify/results/selftest.txt](verify/results/selftest.txt)): 18 Porcupine cases on the partition model (11 known-bad: a stale read, a lost acknowledged write, a wrong value, one incr applied twice, one version given twice, versions out of real-time order, a refusal although the version matched, a write passed on a stale version, a bound crossed, a bound refused although it held, `absent` passed on a present row) and 8 Elle cases (G0, G1a, G1c, G-single, G2-item, a list that loses an element, a duplicate; one good). Every known-bad case is flagged, every good one passes.

## Q-22's parts, answered

- **A sixth kernel operation?** No. 22 patterns, nine L5 libraries and every fix use `append`, `read`, `snapshot`, `changeMembers` and `handOver` only. The fixes are rules: L2 (a refusal waits for a commit), L4 (a bound write waits for its session), L5 (unit-owned saga locks; a saga step's undo). (measured here)
- **Atomic visibility across partitions?** No MUST needs it. P-15's MUST (no unit half-forgotten, no G0) holds with sagas and F3's two rules; its SHOULD (no fractured read) is not met by sagas: Elle finds G-single in 66 to 77 of 100 histories. So X `saga` is enough for the MUSTs, at two more L5 rules than API.md lists; RAMP (E-24) or a transaction is the only route to the SHOULD. (measured here)
- **Safe only at the writer?** Nothing. A check-then-set is safe with a condition or an op wherever the call runs (step 2's 120 races; here 300 more runs under forced faults and the shuffle, Porcupine clean), and unsafe without one even at the writer, including one call at a time per row across a failover (step 2, D15). What the writer must do is wait: a refusal judged at the writer is linearizable only once the log end it read has committed (F1). U `any` stands; Q-A8's `at: 'writer'` is a latency choice, not a safety one. (measured here)
- **Order that will not last?** No pattern example passed only without the shuffle; the planted two-partition app did (25 of 100 failed with it, 0 without), and its one-partition form never failed. (measured here)
- **TEST-01:** after step 2's ten fixes and step 3's three, step 1's bench, 3 runs under the timing lock ([verify/results/test01.txt](verify/results/test01.txt)):

  | Measure | Bar | Run 1 | Run 2 | Run 3 | Median of runs (range) |
  |---|---|---|---|---|---|
  | a fresh node plus a scenario, p50 / p99 / max of 2,000 | ≤ 5 ms | 0.143 / 3.55 / 8.7 ms | 0.124 / 3.51 / 10.0 ms | 0.160 / 3.77 / 9.5 ms | p50 0.143 ms (0.124 to 0.160), p99 3.55 ms (3.51 to 3.77) |
  | 200 chaos seeds (274,339 events) | ≤ 1 s | 646 ms | 653 ms | 751 ms | 653 ms (646 to 751) |
  | load average at start | | 6.85 | 8.12 | 2.61 | |

  Both bars hold, as in step 1. The max (about 1 in 2,000) is still over 5 ms. The 200 chaos seeds took 1.7 times step 1's 380 ms for exactly the same 274,339 events (2.4 to 2.7 µs an event against 1.4): the simulation did the same work, more slowly. Not explained here: step 3's only addition on this path is two history fields per write, and the box carried other agents' load just before each run (the load averages above).

## The verdict against Q-22's threshold

| Threshold (QUESTIONS.md) | Result |
|---|---|
| All patterns run on the five operations and pass their checks and the outside checkers with leader changes and moves injected → K `lib` confirmed | **Met, after fixes.** 22 of 22 patterns on five operations; every pattern check passes in every seed and mode except two check expectations (P-10, P-11) traced to the check, not to a broken guarantee; Porcupine clean on 183,159 partitions; Elle clean of G0 with F3's rules. K `lib` confirmed. |
| A pattern needing a sixth operation, or atomic visibility across partitions, is named with its cheapest fix; X `saga` is enough only if no MUST needs atomic visibility | **None needs either.** X `saga` is enough for every MUST, but only with locks owned by the unit (F3: two L5 rules, Percolator's). P-15's SHOULD is unmet (G-single), as planned. |
| Check-then-set safe only at the writer → U `ldr`, or a condition on every such write | **Not safe at the writer either.** A condition (or an op) on every such write is the rule; U `ldr` buys nothing. |
| An example that passes only without the shuffle leans on order that will not last | **None of the 22.** The planted one does, so the shuffle would catch one. |
| A new node plus a scenario ≤ 5 ms → TEST-01 holds | **Holds:** p50 0.14 ms, p99 3.6 ms; 200 chaos seeds 0.65 s (bar 1 s). |

**Moves.** MIN and its K `lib` family up on P-01 to P-22, DATA-01, TEST-01, TEST-02, TEST-12 and TEST-13; X `saga` holds the MUSTs with two more L5 rules (counted against DEV-01 for every row with X `saga`); U `ldr` down (no safety); every candidate whose writer answers refusals from an uncommitted tail must add F1's wait (all rows judge at a writer; the rule costs no mechanism, one commit wait).

## API changes this step shows

From [API-NOTES.md](API-NOTES.md) part F (steps 1 and 2's are parts C and D):
1. A refusal, an empty `claim` and a `call-diverged` answer are sent only once the log end they were judged on has committed (F1). P-14's "linearizable per partition" needs it.
2. A `while: 'session'` write is sent only after its session's record has committed, or the writer refuses a write bound to a session it does not know (F2).
3. P-15: saga locks belong to the unit until it finishes or is undone; each step carries its partition lock's fence; a saga resolves another's unfinished, locked intent before writing where it wrote (F3).
4. `Step.undo`, and `saga` refuses a step whose op it cannot invert (F4).
5. P-10 says what fencing gives: no write under a token older than one *that writer has seen*; a stale write can land between a new grant and the new holder's first protected write; a lease can outlast a pause by one `election.ms` per `#locks` election (F5).

## Bugs fixed in the prototype (step 3)

G1 (L2: refusals answered before their log end committed), G2 (L4: bound writes before their session existed), G3 (the simulation: an election that left the replaced voter out of its majority count). Each is a few lines in [proto/](proto), marked "bug fix, E-22 step 3", with the check that found it ([API-NOTES.md](API-NOTES.md) part G). Steps 1 and 2's checks still pass after them (the matrix runs them all).

## Method

All step 3's code is in [verify/](verify). It changes no check of steps 1 and 2. Besides the three fixes of part G, two fields were added to step 1's client history (the write's attempt id and its body: [proto/api.ts](proto/api.ts) and [proto/world.ts](proto/world.ts), marked "E-22 step 3"), so a checker can tie a client's operation to the log.

**Three modes, 100 seeds each.** [verify/run3.ts](verify/run3.ts) loads a check module and runs it under one mode; it wraps step 1's harness from outside (it replaces `fero.world` with a version that sets the mode and installs recorders).

| Mode | Shuffle (TEST-12) | The check's random faults (its `chaos` call) | Forced faults | The check's scripted scenario (kills, pauses, skews, message loss, the failover a pattern is about) |
|---|---|---|---|---|
| calm | off | dropped | none | kept |
| faults | off | kept | one leader change + one slot move | kept |
| shuffle | on | kept | one leader change + one slot move | kept |

**Forced faults land during the work, by construction.** Each fires at a seeded time inside the window the check gave its own faults (its `within`: the author's estimate of the work's virtual length). At that moment it picks a write that is in flight (invoked, not yet answered) and changes the leader of that write's group, or moves that write's slot to the other group. If no write is in flight, it waits for the next write to start and fires 0.05 to 0.6 ms after it. Coverage is measured, not assumed: per seed, whether an election overlapped a client operation on the same resource, and whether a slot move did.

**What is recorded per seed.** Every verb's invoke and completion (with its attempt id, body, answer, version or refusal), every entry at the moment it commits (with its append and commit times), and every election.

**Direct checks** (exact, every seed, every check):

| Check | What it asserts |
|---|---|
| once | no attempt id commits twice in one resource |
| refusal | a write refused once (and not sent again under the same id) never commits later (P-14) |
| acked | every acknowledged write is in the committed log, with the version its answer gave |
| kept | no committed entry is later replaced or dropped (Raft's safety, in the prototype) |
| fence-log | in each group's log, no write under a fence token older than one already in that log, per lock (TEST-13's fencing checker) |
| fence-rt | no fenced write is acknowledged if it started after a write under a newer token of the same lock was acknowledged (a stronger, real-time form) |
| session | a process's plain reads of a row never go back in version, and see its own writes (the read floor API.md §4 promises) |

**Porcupine** ([verify/go/model.go](verify/go/model.go)). One history per partition per seed: writes, conditional writes, ops, claims, touches and fresh reads. The model is a partition's rows, each with a version and a value:
- an acknowledged write gets a version above every earlier write of its partition (versions are `epoch:index`, so string order is log order across failovers and moves);
- its conditions (`absent`, `present`, `version`, `equals`) held; a `conflict` refusal means one of them, or an op's bound, really failed; `absent-row` means the row was absent;
- an op's answer (`incr` with bounds, `push`, `merge`, `max`, `min`) is what the op gives on the row as it stood;
- a fresh read returns the row's version and value;
- a write whose client never got an answer (it died, or timed out) is looked up in the committed log by its attempt id: if it committed, it enters with that effect and may land any time after its call; if not, it is dropped;
- entries the writer made itself (ttl, `max`, `where` and session removals) enter between their append and their commit.
Plain reads are left out: they are not promised to be linearizable (the `session` check covers what they do promise). `expired` and `fence` conditions are not modelled (either answer is legal); the fence checks cover fences. Rows changed by a shape bump (P-20) are checked by version only.

**Elle** (list-append). [verify/elle-saga.check.ts](verify/elle-saga.check.ts) writes P-15 as units Elle can read: 12 units, each a saga that pushes its number onto the lists of 2 or 3 rows; 4 holders (one killed, one paused 25 s past its lease), 2 recoverers that call the same saga ids later, 3 readers that read 2 or 3 rows with fresh reads one after another, and a final read of every row. Each unit becomes an Elle transaction of appends (`:ok` if its intent row says `done`, `:fail` if `undone`, `:info` if neither); each reader's reads one transaction. Four variants: `saga` (step 2's library, as P-15 is built), `owned` (the same with F3's two rules, [verify/saga-owned.ts](verify/saga-owned.ts)), `undo` (every third unit's last step carries a condition that fails, so the saga undoes its earlier steps), `nolock` (a planted bad app: no saga, plain pushes in seeded order).

**Mutants.** Two planted kernel bugs, run under the register workload ([verify/lin-kv.check.ts](verify/lin-kv.check.ts)) and three pattern checks, to show the checkers catch real bugs in real histories of this system: `nodedup` (each writer forgets its attempt table before it judges a request, so a resend applies twice) and `lostcommit` (after each election the new leader lacks the newest committed write and what follows it).

**TEST-12's teeth.** [verify/planted-order.check.ts](verify/planted-order.check.ts): a writer adds a document, then points `latest` at it; a server's tap reads the pointer, then the document it names. In two partitions the app leans on order across partitions; in one partition it does not.

## Tools, exactly

- **Porcupine v1.3.1** (Anish Athalye), `github.com/anishathalye/porcupine`, fetched with Go modules (Go 1.24.7, `GOTOOLCHAIN=local`) and checked by the Go checksum database (`h1:fBZ4/NGNPnIDdd6xNtrNk9/GiEQ0L4FO5+scINN+t0E=`). The model for fero's partitions is ours: [verify/go/model.go](verify/go/model.go).
- **Elle's list-append checker, as ported to Go** in `github.com/pingcap/tipocket` v1.0.0, `pkg/elle` (`h1:gRvhXc+R8cveoI+FnlX2zWaj5VN/9Ec1ZgpTHpm2G+E=`). Elle itself (Clojure, `elle/elle`) is on Clojars, which this box's proxy refuses (403), and it is not on Maven Central. tipocket's module pulls Kubernetes, TiDB and chaos-mesh, so [verify/fetch.sh](verify/fetch.sh) copies `pkg/elle/{core,txn,list_append}` out of the verified module zip, leaving out two files nothing calls (`viz.go`, graphviz plotting; `wr_txn.go`, a random history generator). The port is less proven than Elle; the self-test above is our check of it.
- **Our own direct checks** (TypeScript, [verify/run3.ts](verify/run3.ts)), including TEST-13's fencing checker.
- Not used: Knossos and Maelstrom (Clojure, the same Clojars block); Jepsen's own Elle jar.

## What this cannot show

- **A simulation, as steps 1 and 2:** no sockets, disks or real clocks; Raft modelled at "what each voter persisted and acked", no joint consensus (E-14) or PreVote (E-38). A history is linearizable *in this model of the kernel*; a real kernel needs the same checkers on real-TCP runs (TEST-13 asks for that from phase 1).
- **Porcupine checks writes, conditional writes, ops, claims, touches and fresh reads.** Plain reads are not promised linearizable and are checked only for session order. `expired` conditions and fences are not in the model (either answer is legal there); the fence checks cover fences. Rows changed by a shape bump are checked by version only.
- **Elle runs on one workload built for it** (P-15's units as list appends), not on every pattern. Consumer-group and derive outputs in other groups (Q-30) are E-30's.
- **The forced faults are one leader change and one move per seed, aimed at a write in flight.** More, or other kinds (a partition between two servers, a slow disk), are E-38's and E-29's.
- **The saga with owned locks** ([verify/saga-owned.ts](verify/saga-owned.ts)) is a test of the two rules, not a finished library: it scans its replica of `#sagas` for blockers, which a real build would index.
- **TEST-01's numbers are the prototype's** (step 1's caveat).

## Run it

`verify/run.sh` (build, types, self-test, matrix, Porcupine, Elle, mutants, timing, report), or one step: `verify/run.sh matrix`. One check, one mode: `node --experimental-strip-types --no-warnings verify/run3.ts patterns/checks/p13.check.ts --mode shuffle --seeds 100 --hist /tmp/h.jsonl`, then `$SP/e22v/go-build/e22check lin /tmp/h.jsonl`; add `--seed 7 --trace` to replay one seed. [verify/fetch.sh](verify/fetch.sh) builds the Go checkers. Histories (about 300 MB) stay in `$SP/e22v/`. Machine: 4 vCPU, Node 22.22.0, Go 1.24.7, TypeScript 6.0.2, data 63fea66. Heavy runs under `$SP/bin/heavy`, timing under `$SP/bin/timing`.

Q-22: the API covers all 22 patterns on the kernel's five operations with no sixth, and every pattern check, Porcupine (183,159 partition histories, all linearizable) and Elle hold under forced leader changes, slot moves and 100 seeds of the shuffle, after three rules the checkers forced: a refusal waits for the commit of what it was judged on (Porcupine found a refusal by a write that was then lost), a session-bound write waits for its session, and saga locks belong to the unit (Elle found G0 between units in 10 to 19 of 100 histories without it); no MUST needs atomic visibility (fractured reads remain, P-15's SHOULD), nothing is safe only at the writer, and TEST-01 holds (a fresh node plus a scenario 0.14 ms median, 3.6 ms p99, against 5 ms; 200 chaos seeds 0.65 s against 1 s). Moves: MIN and its K `lib` family up on P-01 to P-22, TEST-01, TEST-02, TEST-12 and TEST-13; X `saga` up for the MUSTs at two more L5 rules (DEV-01); U `ldr` down; every candidate takes F1's refusal wait and F2's session order.
