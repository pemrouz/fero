## res

Bounds (the design): hl0: 15 states; hln: 15 states; hp0: 186 states; hd0: 78 states; l1: 1,006 states; hgn: 6,308 states; four1: 13,726 states; f1: 21,359 states; ll2: 18,164 states; hg1: 54,547 states; lh1: 109,071 states
Verify (the smallest model): h1: 3,033,232 states, holds; lf1: 5,000,001 states, limit

**44 rules needed** of 87 written; by role: dir 1, hand 2, hint 9, place 4, pref 2, retire 4, step 4, swap 3, target 10, xfer 5.

Distinct checks (one guard repeated in several actions of one actor counted once): **42**; Raft's own guards (role raft: a working leader, one change at a time) among the 44: 0.

| rule | kind | role | removing it breaks |
|---|---|---|---|
| `add.cand` | guard | target | undecided (h1: state limit) |
| `add.new` | guard | target | P9 on hl0 (18 steps) |
| `add.notret` | guard | retire | P7 on ll2 (4 steps) |
| `add.append` | update | step | PE on hp0 (2 steps) |
| `promote.learner` | guard | target | P9 on hl0 (18 steps) |
| `promote.live` | guard | target | P2C on h1 (11 steps) |
| `promote.caught` | guard | swap | P2C on hp0 (12 steps) |
| `promote.odd` | guard | target | P3 on h1 (15 steps) |
| `promote.placed` | guard | place | P9 on l1 (23 steps) |
| `promote.notret` | guard | retire | P7 on ll2 (9 steps) |
| `promote.append` | update | step | PE on hp0 (2 steps) |
| `remove.voter` | guard | target | P9 on h1 (36 steps) |
| `remove.gone` | guard | target | P2 on hp0 (14 steps) |
| `remove.four` | guard | swap | P3 on hgn (4 steps) |
| `remove.append` | update | step | P8 on four1 (2 steps) |
| `surplus.four` | guard | target | P2 on hp0 (3 steps) |
| `surplus.last` | guard | target | P9 on hp0 (22 steps) |
| `surplus.allheld` | guard | swap | P2 on hp0 (14 steps) |
| `surplus.append` | update | step | PE on hp0 (2 steps) |
| `dial.link` | update | dir | PE on hp0 (2 steps) |
| `pick.need` | guard | place | P9 on hp0 (18 steps) |
| `pick.cand` | guard | target | P9 on hg1 (21 steps) |
| `pick.new` | guard | place | P8 on l1 (3 steps) |
| `pick.notret` | guard | retire | P9 on ll2 (21 steps) |
| `pick.append` | update | place | P8 on l1 (1 steps) |
| `leave.mark` | update | retire | LD on l1 (4 steps) |
| `drain.mark` | update | hint | LD on hd0 (4 steps) |
| `handover.self` | guard | hint | P9L on hl0 (5 steps) |
| `handover.voter` | guard | xfer | P9L on l1 (17 steps) |
| `handover.notdrn` | guard | hint | P9L on hd0 (6 steps) |
| `handover.transfer` | update | xfer | DR on hd0 (1 steps) |
| `lead.caught` | guard | xfer | LD on lh1 (2 steps) |
| `lead.notdrn` | guard | hint | LD on lh1 (2 steps) |
| `lead.transfer` | update | xfer | LE on hln (1 steps) |
| `lead.pref` | update | hint | LH on hl0 (3 steps) |
| `place.append` | update | hint | PE on hp0 (1 steps) |
| `gone.link` | guard | hint | P2 on hgn (9 steps) |
| `gone.mark` | update | hint | P8 on hgn (2 steps) |
| `handback.voter` | guard | hand | LD on h1 (18 steps) |
| `handback.settle` | guard | hand | P9L on hl0 (5 steps) |
| `handback.notdrn` | guard | hint | LD on hd0 (4 steps) |
| `handback.transfer` | update | xfer | LB on hp0 (14 steps) |
| `repref.need` | guard | pref | LH on hl0 (4 steps) |
| `repref.set` | update | pref | PR on hp0 (2 steps) |

Pinned (bounds and world steps written as rules, never dropped or mutated): `leave.start`, `drain.start`, `lead.budget`, `place.budget`, `gone.budget`.

Put back by the verify bound: `promote.live` (put back: alone on h1 it breaks P2C in 14 steps); `promote.odd` (put back: alone on h1 it breaks P3 in 15 steps); `remove.voter` (put back: alone on h1 it breaks P9 in 36 steps); `handback.voter` (put back: alone on h1 it breaks LD in 21 steps).

Undecided on the verify bound (stopped at the state limit, so not put back): `dropl.learner`, `dropl.gone`.

The smallest model on the verify bound: stopped at the state limit with no counterexample (5,000,001 states).

Dropped (no property breaks without them, given the rules kept): `add.leader`, `add.idle`, `add.need`, `add.placed`, `promote.leader`, `promote.idle`, `promote.need`, `remove.leader`, `remove.idle`, `remove.newok`, `surplus.leader`, `surplus.idle`, `surplus.voter`, `surplus.nogone`, `dropl.leader`, `dropl.idle`, `dropl.learner`, `dropl.gone`, `dropl.append`, `dial.leader`, `pick.leader`, `pick.idle`, `leave.unlist`, `handover.leader`, `handover.notme`, `handover.live`, `handover.caught`, `lead.leader`, `lead.stale`, `lead.voter`, `lead.notme`, `lead.live`, `place.leader`, `place.idle`, `place.stale`, `place.reach`, `gone.leader`, `handback.leader`, `handback.notme`, `handback.live`, `handback.caught`, `repref.leader`, `repref.first`.

**Mutants:** 48; caught 46; equivalent 0; undecided 2; survived 0. Caught of non-equivalent: 46/48 (96%).

| mutant | kind | result |
|---|---|---|
| `add.cand` | drop | undecided |
| `add.new` | drop | P9 on hl0 (18 steps) |
| `add.notret` | drop | P7 on ll2 (4 steps) |
| `add.append` | drop | PE on hp0 (2 steps) |
| `promote.learner` | drop | P9 on hl0 (18 steps) |
| `promote.live` | drop | P2C on h1 (11 steps) |
| `promote.caught` | drop | P2C on hp0 (12 steps) |
| `promote.odd` | drop | P3 on h1 (15 steps) |
| `promote.placed` | drop | P9 on l1 (23 steps) |
| `promote.notret` | drop | P7 on ll2 (9 steps) |
| `promote.append` | drop | PE on hp0 (2 steps) |
| `remove.voter` | drop | P9 on h1 (36 steps) |
| `remove.gone` | drop | P2 on hp0 (14 steps) |
| `remove.four` | drop | P3 on hgn (4 steps) |
| `remove.append` | drop | P8 on four1 (2 steps) |
| `surplus.four` | drop | P2 on hp0 (3 steps) |
| `surplus.last` | drop | P9 on hp0 (22 steps) |
| `surplus.allheld` | drop | P2 on hp0 (14 steps) |
| `surplus.append` | drop | PE on hp0 (2 steps) |
| `dial.link` | drop | PE on hp0 (2 steps) |
| `pick.need` | drop | P9 on hp0 (18 steps) |
| `pick.cand` | drop | P9 on hg1 (21 steps) |
| `pick.new` | drop | P8 on l1 (3 steps) |
| `pick.notret` | drop | P9 on ll2 (21 steps) |
| `pick.append` | drop | P8 on l1 (1 steps) |
| `leave.mark` | drop | LD on l1 (4 steps) |
| `drain.mark` | drop | LD on hd0 (4 steps) |
| `handover.self` | drop | P9L on hl0 (5 steps) |
| `handover.voter` | drop | P9L on l1 (17 steps) |
| `handover.notdrn` | drop | P9L on hd0 (6 steps) |
| `handover.transfer` | drop | DR on hd0 (1 steps) |
| `lead.caught` | drop | LD on lh1 (2 steps) |
| `lead.notdrn` | drop | LD on lh1 (2 steps) |
| `lead.transfer` | drop | LE on hln (1 steps) |
| `lead.pref` | drop | LH on hl0 (3 steps) |
| `place.append` | drop | PE on hp0 (1 steps) |
| `gone.link` | drop | P2 on hgn (9 steps) |
| `gone.mark` | drop | P8 on hgn (2 steps) |
| `handback.voter` | drop | LD on h1 (18 steps) |
| `handback.settle` | drop | P9L on hl0 (5 steps) |
| `handback.notdrn` | drop | LD on hd0 (4 steps) |
| `handback.transfer` | drop | LB on hp0 (14 steps) |
| `repref.need` | drop | LH on hl0 (4 steps) |
| `repref.set` | drop | PR on hp0 (2 steps) |
| `promote.odd` | flip | P3 on h1 (15 steps) |
| `remove.four` | flip | P8 on four1 (2 steps) |
| `surplus.four` | flip | PE on hp0 (2 steps) |
| `lead: transfer <-> pref` | swap | undecided |

## Rules by record (models/count.py)

| record | written | kept | distinct checks kept | kept with a counterexample |
|---|---|---|---|---|
| healing-self@per-resource | 43 | **22** | 19 | 21 |
| meta-members@per-resource | 5 | **4** | 2 | 4 |
| planner-hints@per-resource | 12 | **9** | 7 | 9 |
| hand-back (V5-7) | 8 | **4** | 4 | 4 |
| raft-leader-transfer | 11 | **5** | 5 | 5 |
| raft (a working leader; one entry at a time) | 8 | **0** | 0 | 0 |
| **total** | 87 | **44** | 37 (summed per record) | 43 |

### healing-self@per-resource

| rule | stands for | kept | removing it breaks | alone on the sweep |
|---|---|---|---|---|
| `add.leader` | E-16 dropped it | no | - | - |
| `add.idle` | E-16 dropped it | no | - | - |
| `add.cand` | E-16 dropped it | yes | undecided (h1: state limit) | P9 on hgn, 20 steps |
| `add.new` | E-16's 14 | yes | P9 on hl0, 18 steps | P9 on hp0, 18 steps |
| `add.need` | E-16 dropped it | no | - | - |
| `add.placed` | rule 15 (read side): adds and promotions follow the stored placement | no | - | - |
| `add.append` | E-16's 14 | yes | PE on hp0, 2 steps | PE on hp0, 2 steps |
| `promote.leader` | E-16 dropped it | no | - | - |
| `promote.idle` | E-16 dropped it | no | - | - |
| `promote.learner` | E-16's 14 | yes | P9 on hl0, 18 steps | P9 on hp0, 18 steps |
| `promote.live` | E-16 dropped it | yes | P2C on h1, 11 steps | - |
| `promote.caught` | E-16 dropped it | yes | P2C on hp0, 12 steps | P2C on hp0, 12 steps |
| `promote.need` | E-16's 14 | no | - | - |
| `promote.odd` | E-16's 14 | yes | P3 on h1, 15 steps | - |
| `promote.placed` | rule 15 (read side): adds and promotions follow the stored placement | yes | P9 on l1, 23 steps | - |
| `promote.append` | E-16's 14 | yes | PE on hp0, 2 steps | PE on hp0, 2 steps |
| `remove.leader` | E-16 dropped it | no | - | - |
| `remove.idle` | E-16 dropped it | no | - | - |
| `remove.voter` | E-16's 14 | yes | P9 on h1, 36 steps | - |
| `remove.gone` | E-16's 14 | yes | P2 on hp0, 14 steps | P2 on hp0, 14 steps |
| `remove.four` | E-16's 14 | yes | P3 on hgn, 4 steps | P3 on hgn, 4 steps |
| `remove.newok` | E-16 dropped it | no | - | - |
| `remove.append` | E-16's 14 | yes | P8 on four1, 2 steps | P8 on hgn, 2 steps |
| `surplus.leader` | E-16 dropped it | no | - | - |
| `surplus.idle` | E-16 dropped it | no | - | - |
| `surplus.voter` | E-16 dropped it | no | - | - |
| `surplus.four` | E-16's 14 | yes | P2 on hp0, 3 steps | P2 on hp0, 3 steps |
| `surplus.nogone` | E-16 dropped it | no | - | - |
| `surplus.last` | E-16's 14 | yes | P9 on hp0, 22 steps | P9 on hp0, 22 steps |
| `surplus.allheld` | E-16's 14 | yes | P2 on hp0, 14 steps | P2 on hp0, 14 steps |
| `surplus.append` | E-16's 14 | yes | PE on hp0, 2 steps | PE on hp0, 2 steps |
| `dropl.leader` | E-16 dropped it | no | - | - |
| `dropl.idle` | E-16 dropped it | no | - | - |
| `dropl.learner` | E-16 dropped it | no | - | P9 on hgn, 20 steps |
| `dropl.gone` | E-16 dropped it | no | - | P9 on hp0, 22 steps |
| `dropl.append` | E-16 dropped it | no | - | - |
| `dial.link` | new: dial a machine the directory lists before using it | yes | PE on hp0, 2 steps | PE on hp0, 2 steps |
| `pick.leader` | the pick | no | - | - |
| `pick.idle` | the pick | no | - | - |
| `pick.need` | the pick | yes | P9 on hp0, 18 steps | P9 on hp0, 18 steps |
| `pick.cand` | high bound: add.cand (reached within evict.after) | yes | P9 on hg1, 21 steps | P9 on hg1, 21 steps |
| `pick.new` | the pick | yes | P8 on l1, 3 steps | P8 on l1, 2 steps |
| `pick.append` | rule 15: the pick written to the log before the add | yes | P8 on l1, 1 steps | P8 on l1, 1 steps |

### meta-members@per-resource

| rule | stands for | kept | removing it breaks | alone on the sweep |
|---|---|---|---|---|
| `add.notret` | rule 2: never a new copy on a retiring machine | yes | P7 on ll2, 4 steps | P7 on ll2, 6 steps |
| `promote.notret` | rule 2: never a new copy on a retiring machine | yes | P7 on ll2, 9 steps | P7 on ll2, 9 steps |
| `pick.notret` | rule 2: never a new copy on a retiring machine | yes | P9 on ll2, 21 steps | P9 on ll2, 21 steps |
| `leave.mark` | rule 1: says retiring first | yes | LD on l1, 4 steps | LD on l1, 4 steps |
| `leave.unlist` | rule 1: leaves the directory | no | - | - |

### planner-hints@per-resource

| rule | stands for | kept | removing it breaks | alone on the sweep |
|---|---|---|---|---|
| `drain.mark` | rule 5: a draining process says so in its pings | yes | LD on hd0, 4 steps | LD on hd0, 4 steps |
| `handover.self` | rule 5: drains hand over, never to a draining member | yes | P9L on hl0, 5 steps | P9L on hl0, 5 steps |
| `handover.notdrn` | rule 5: drains hand over, never to a draining member | yes | P9L on hd0, 6 steps | LD on ll2, 3 steps |
| `lead.stale` | rule 1: stale-plan | no | - | - |
| `lead.notdrn` | rule 5: drains hand over, never to a draining member | yes | LD on lh1, 2 steps | LD on lh1, 2 steps |
| `lead.pref` | rule 4: a lead hint sets the preferred leader | yes | LH on hl0, 3 steps | LH on hl0, 3 steps |
| `place.stale` | rule 1: stale-plan | no | - | - |
| `place.reach` | rule 3: adds only to reachable machines | no | - | - |
| `place.append` | the hint path: write the hint's placement | yes | PE on hp0, 1 steps | PE on hp0, 1 steps |
| `gone.link` | rule 2: a gone hint is ignored while the leader's link is up | yes | P2 on hgn, 9 steps | P2 on hgn, 9 steps |
| `gone.mark` | the hint path: take the gone hint | yes | P8 on hgn, 2 steps | P8 on hgn, 2 steps |
| `handback.notdrn` | rule 5: no hand-back to a draining member | yes | LD on hd0, 4 steps | LD on hd0, 4 steps |

### hand-back (V5-7)

| rule | stands for | kept | removing it breaks | alone on the sweep |
|---|---|---|---|---|
| `handback.notme` | when the hand-back runs | no | - | - |
| `handback.voter` | when the hand-back runs | yes | LD on h1, 18 steps | - |
| `handback.live` | when the hand-back runs | no | - | - |
| `handback.caught` | when the hand-back runs | no | - | - |
| `handback.settle` | when the hand-back runs | yes | P9L on hl0, 5 steps | - |
| `repref.need` | who is preferred once the preferred member leaves the placement | yes | LH on hl0, 4 steps | LH on hl0, 4 steps |
| `repref.first` | who is preferred once the preferred member leaves the placement | no | - | - |
| `repref.set` | who is preferred once the preferred member leaves the placement | yes | PR on hp0, 2 steps | PR on hp0, 2 steps |

### raft-leader-transfer

| rule | stands for | kept | removing it breaks | alone on the sweep |
|---|---|---|---|---|
| `handover.voter` | the transfer's own checks | yes | P9L on l1, 17 steps | P9L on l1, 20 steps |
| `handover.notme` | the transfer's own checks | no | - | - |
| `handover.live` | the transfer's own checks | no | - | - |
| `handover.caught` | the transfer's own checks | no | - | - |
| `handover.transfer` | the transfer's own checks | yes | DR on hd0, 1 steps | DR on hd0, 1 steps |
| `lead.voter` | the transfer's own checks | no | - | - |
| `lead.notme` | the transfer's own checks | no | - | - |
| `lead.live` | the transfer's own checks | no | - | - |
| `lead.caught` | the transfer's own checks | yes | LD on lh1, 2 steps | - |
| `lead.transfer` | the transfer's own checks | yes | LE on hln, 1 steps | LE on hln, 1 steps |
| `handback.transfer` | the transfer itself | yes | LB on hp0, 14 steps | LB on hp0, 14 steps |

### raft (a working leader; one entry at a time)

| rule | stands for | kept | removing it breaks | alone on the sweep |
|---|---|---|---|---|
| `dial.leader` | Raft's own | no | - | - |
| `handover.leader` | Raft's own | no | - | - |
| `lead.leader` | Raft's own | no | - | - |
| `place.leader` | Raft's own | no | - | - |
| `place.idle` | Raft's own | no | - | - |
| `gone.leader` | Raft's own | no | - | P8 on hgn, 2 steps |
| `handback.leader` | Raft's own | no | - | - |
| `repref.leader` | Raft's own | no | - | - |
