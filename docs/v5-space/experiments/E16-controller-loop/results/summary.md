## self

Bounds (the design): three1: 2,213 states; four1: 1,673 states; meta1: 4,762 states
Verify (the smallest model): three2: 1,545,198 states, holds

**14 rules needed** of 34 written; by role: step 4, swap 2, target 8.

Distinct checks (one guard repeated in several actions of one actor counted once): **13**; Raft's own guards (role raft: a working leader, one change at a time) among the 14: 0.

| rule | kind | role | removing it breaks |
|---|---|---|---|
| `add.new` | guard | target | undecided (three1: state limit) |
| `add.append` | update | step | P8 on three1 (1 steps) |
| `promote.learner` | guard | target | P9 on three1 (20 steps) |
| `promote.need` | guard | target | P9 on three1 (18 steps) |
| `promote.odd` | guard | target | P3 on three1 (11 steps) |
| `promote.append` | update | step | P8 on three1 (1 steps) |
| `remove.voter` | guard | target | P9 on three1 (21 steps) |
| `remove.gone` | guard | target | P2 on three1 (7 steps) |
| `remove.four` | guard | swap | P3 on three1 (4 steps) |
| `remove.append` | update | step | P8 on three1 (1 steps) |
| `surplus.four` | guard | target | P2 on three1 (1 steps) |
| `surplus.last` | guard | target | P9 on three2 (29 steps) |
| `surplus.allheld` | guard | swap | P2 on three1 (7 steps) |
| `surplus.append` | update | step | P8 on three1 (7 steps) |

Put back by the verify bound: `remove.voter` (put back: alone on three2 it breaks P9 in 23 steps); `remove.append` (put back: alone on three2 it breaks P8 in 1 steps); `dropl.learner` (put back: alone on three2 it breaks P9 in 20 steps; dropped again in the final pass after the verify); `dropl.gone` (put back: alone on three2 it breaks P9 in 20 steps; dropped again in the final pass after the verify); `add.cand` (put back: alone on three2 it breaks P9 in 20 steps; dropped again in the final pass after the verify); `remove.gone` (put back: alone on three2 it breaks P2 in 8 steps); `remove.four` (put back: alone on three2 it breaks P3 in 4 steps); `surplus.last` (put back: without it the smallest model breaks P9 on three2 in 29 steps).

Dropped (no property breaks without them, given the rules kept): `add.leader`, `add.idle`, `add.cand`, `add.need`, `promote.leader`, `promote.idle`, `promote.live`, `promote.caught`, `remove.leader`, `remove.idle`, `remove.newok`, `surplus.leader`, `surplus.idle`, `surplus.voter`, `surplus.nogone`, `dropl.leader`, `dropl.idle`, `dropl.learner`, `dropl.gone`, `dropl.append`.

**Mutants:** 17; caught 16; equivalent 0; undecided 1; survived 0. Caught of non-equivalent: 16/17 (94%).

| mutant | kind | result |
|---|---|---|
| `add.new` | drop | undecided |
| `add.append` | drop | P8 on three1 (1 steps) |
| `promote.learner` | drop | P9 on three1 (20 steps) |
| `promote.need` | drop | P9 on three1 (18 steps) |
| `promote.odd` | drop | P3 on three1 (11 steps) |
| `promote.append` | drop | P8 on three1 (1 steps) |
| `remove.voter` | drop | P9 on three1 (21 steps) |
| `remove.gone` | drop | P2 on three1 (7 steps) |
| `remove.four` | drop | P3 on three1 (4 steps) |
| `remove.append` | drop | P8 on three1 (1 steps) |
| `surplus.four` | drop | P2 on three1 (1 steps) |
| `surplus.last` | drop | P9 on three2 (29 steps) |
| `surplus.allheld` | drop | P2 on three1 (7 steps) |
| `surplus.append` | drop | P8 on three1 (7 steps) |
| `promote.odd` | flip | P3 on three1 (11 steps) |
| `remove.four` | flip | P8 on three1 (1 steps) |
| `surplus.four` | flip | P8 on three1 (7 steps) |

## cent-co

Bounds (the design): three1: 4,315 states; four1: 3,193 states; meta1: 4,712 states
Verify (the smallest model): three2: 2,000,001 states, limit

**18 rules needed** of 38 written; by role: epoch 1, idem 1, step 5, swap 2, target 7, view 2.

Distinct checks (one guard repeated in several actions of one actor counted once): **17**; Raft's own guards (role raft: a working leader, one change at a time) among the 18: 0.

| rule | kind | role | removing it breaks |
|---|---|---|---|
| `c_add.cand` | guard | target | undecided (three2: state limit) |
| `c_add.new` | guard | target | undecided (three1: state limit) |
| `c_add.issue` | update | step | P8 on three1 (1 steps) |
| `c_promote.learner` | guard | target | undecided (three1: state limit) |
| `c_promote.need` | guard | target | undecided (three1: state limit) |
| `c_promote.odd` | guard | target | P3 on three1 (15 steps) |
| `c_promote.issue` | update | step | P8 on three1 (1 steps) |
| `c_remove.voter` | guard | target | undecided (three1: state limit) |
| `c_remove.four` | guard | swap | P3 on three1 (5 steps) |
| `c_remove.issue` | update | step | undecided (three2: state limit) |
| `c_surplus.four` | guard | target | P2 on three1 (2 steps) |
| `c_surplus.issue` | update | step | P8 on three1 (9 steps) |
| `c_expire.drop` | update | idem | undecided (three2: state limit) |
| `exec.epoch` | guard | epoch | P2 on three1 (14 steps) |
| `exec.allheld` | guard | swap | P2 on three1 (10 steps) |
| `exec.gone` | guard | view | P2 on three1 (10 steps) |
| `exec.live` | guard | view | undecided (three2: state limit) |
| `exec.append` | update | step | P8 on three1 (1 steps) |

Put back by the verify bound: `exec.live` (put back: alone on three2 it breaks P8 in 8 steps); `c_remove.issue` (put back: alone on three2 it breaks P8 in 1 steps); `c_expire.drop` (put back: alone on three2 it breaks P8 in 7 steps); `c_add.cand` (put back: alone on three2 it breaks P9 in 29 steps); `c_remove.voter` (put back: alone on three2 it breaks P9 in 30 steps); `c_remove.four` (put back: alone on three2 it breaks P3 in 5 steps); `exec.gone` (put back: alone on three2 it breaks P2 in 14 steps).

Undecided on the verify bound (stopped at the state limit, so not put back): `c_dropl.learner`.

The smallest model on the verify bound: stopped at the state limit with no counterexample (2,000,001 states).

Dropped (no property breaks without them, given the rules kept): `c_add.one`, `c_add.need`, `c_promote.one`, `c_promote.live`, `c_remove.one`, `c_remove.gone`, `c_surplus.one`, `c_surplus.voter`, `c_surplus.nogone`, `c_surplus.last`, `c_dropl.one`, `c_dropl.learner`, `c_dropl.gone`, `c_dropl.issue`, `c_expire.stuck`, `exec.leader`, `exec.idle`, `exec.caught`, `exec.newok`, `exec.done`.

**Mutants:** 21; caught 12; equivalent 0; undecided 9; survived 0. Caught of non-equivalent: 12/21 (57%).

| mutant | kind | result |
|---|---|---|
| `c_add.cand` | drop | undecided |
| `c_add.new` | drop | undecided |
| `c_add.issue` | drop | P8 on three1 (1 steps) |
| `c_promote.learner` | drop | undecided |
| `c_promote.need` | drop | undecided |
| `c_promote.odd` | drop | P3 on three1 (15 steps) |
| `c_promote.issue` | drop | P8 on three1 (1 steps) |
| `c_remove.voter` | drop | undecided |
| `c_remove.four` | drop | P3 on three1 (5 steps) |
| `c_remove.issue` | drop | undecided |
| `c_surplus.four` | drop | P2 on three1 (2 steps) |
| `c_surplus.issue` | drop | P8 on three1 (9 steps) |
| `c_expire.drop` | drop | undecided |
| `exec.epoch` | drop | P2 on three1 (14 steps) |
| `exec.allheld` | drop | P2 on three1 (10 steps) |
| `exec.gone` | drop | P2 on three1 (10 steps) |
| `exec.live` | drop | undecided |
| `exec.append` | drop | P8 on three1 (1 steps) |
| `c_promote.odd` | flip | P3 on three1 (15 steps) |
| `c_remove.four` | flip | undecided |
| `c_surplus.four` | flip | P8 on three1 (9 steps) |

## rlog

Bounds (the design): r1: 48 states; r2: 288 states

**9 rules needed** of 11 written; by role: decide 2, epoch 4, fold 2, step 1.

Distinct checks (one guard repeated in several actions of one actor counted once): **9**; Raft's own guards (role raft: a working leader, one change at a time) among the 9: 0.

| rule | kind | role | removing it breaks |
|---|---|---|---|
| `handover.gone` | guard | decide | RL3 on r1 (5 steps) |
| `handover.alive` | guard | decide | RL3 on r1 (5 steps) |
| `handover.append` | update | epoch | RL3 on r1 (1 steps) |
| `takeover.named` | guard | epoch | RL1 on r1 (2 steps) |
| `takeover.wep` | update | epoch | RL3 on r1 (1 steps) |
| `takeover.fold` | update | fold | RL2 on r1 (4 steps) |
| `write.epoch` | guard | epoch | RL1 on r1 (1 steps) |
| `write.append` | update | step | RL3 on r1 (0 steps) |
| `write.fold` | update | fold | RL2 on r1 (2 steps) |

Pinned (bounds and world steps written as rules, never dropped or mutated): `handover.bound`, `write.bound`, `write.count`.

Dropped (no property breaks without them, given the rules kept): `handover.other`, `write.holder`.

**Mutants:** 11; caught 9; equivalent 2; undecided 0; survived 0. Caught of non-equivalent: 9/9 (100%).

| mutant | kind | result |
|---|---|---|
| `handover.gone` | drop | RL3 on r1 (5 steps) |
| `handover.alive` | drop | RL3 on r1 (5 steps) |
| `handover.append` | drop | RL3 on r1 (1 steps) |
| `takeover.named` | drop | RL1 on r1 (2 steps) |
| `takeover.wep` | drop | RL3 on r1 (1 steps) |
| `takeover.fold` | drop | RL2 on r1 (4 steps) |
| `write.epoch` | drop | RL1 on r1 (1 steps) |
| `write.append` | drop | RL3 on r1 (0 steps) |
| `write.fold` | drop | RL2 on r1 (2 steps) |
| `takeover: wep <-> fold` | swap | equivalent |
| `write: append <-> fold` | swap | equivalent |

