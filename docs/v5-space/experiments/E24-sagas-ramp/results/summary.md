## fullundo

Bounds (the design): one: 13,373 states; two: 1,858 states; sub: 9,916 states; three: 391,613 states
Verify (the smallest model): one2: 293,460 states, holds; two-f: 2,432,844 states, holds; sub-f: 3,000,001 states, limit

**41 rules needed** of 60 written; by role: data 2, fence 6, intent 5, lock 5, own 5, recover 2, seq 16.

Distinct checks (one guard repeated in several actions of one actor counted once): **41**; Raft's own guards (role raft: a working leader, one change at a time) among the 41: 0.

| rule | kind | role | removing it breaks |
|---|---|---|---|
| `claim.seq` | guard | seq | ERR on one (3 steps) |
| `claim.free` | guard | lock | undecided (one: state limit) |
| `claim.lock` | update | lock | A1 on one (14 steps) |
| `claim.tok` | update | lock | L1 on one (0 steps) |
| `claim.pc` | update | seq | L1 on one (0 steps) |
| `begin.absent` | guard | intent | A1 on one (16 steps) |
| `begin.noother` | guard | own | A2 on two (13 steps) |
| `begin.intent` | update | intent | L1 on one (0 steps) |
| `adopt.seq` | guard | seq | A1 on one (10 steps) |
| `adopt.unfin` | guard | intent | A1 on one (14 steps) |
| `adopt.tgt` | update | seq | ERR on one (5 steps) |
| `adopt.pc` | update | recover | L1 on one (0 steps) |
| `other.seq` | guard | seq | L1 on two (4 steps) |
| `other.unfin` | guard | own | A2 on two (11 steps) |
| `other.tgt` | update | own | ERR on two (5 steps) |
| `other.pc` | update | recover | L1 on two (2 steps) |
| `backoff.blocked` | guard | own | undecided (one: state limit) |
| `backoff.release` | update | own | L1 on sub (2 steps) |
| `step.seq` | guard | seq | ERR on one (1 steps) |
| `step.fence` | guard | fence | A1 on one (15 steps) |
| `step.data` | update | data | A1 on one (7 steps) |
| `step.pc` | update | seq | L1 on one (5 steps) |
| `fail.seq` | guard | seq | ERR on one (2 steps) |
| `fail.pc` | update | seq | L1 on one (5 steps) |
| `decide.seq` | guard | seq | ERR on one (1 steps) |
| `decide.holds0` | guard | fence | A1 on sub (13 steps) |
| `decide.holdsN` | guard | fence | A1 on sub (13 steps) |
| `decide.intent` | update | intent | A1 on one (15 steps) |
| `decide.pc` | update | seq | L1 on one (5 steps) |
| `undo.seq` | guard | seq | ERR on one (1 steps) |
| `undo.data` | update | data | A1 on one (10 steps) |
| `undo.raise` | update | fence | A1 on one (15 steps) |
| `undo.pc` | update | seq | L1 on one (5 steps) |
| `giveup.lost` | guard | lock | undecided (one: state limit) |
| `giveup.release` | update | lock | L1 on one (4 steps) |
| `giveup.pc` | update | seq | L1 on one (4 steps) |
| `close.seq` | guard | seq | ERR on one (1 steps) |
| `close.holds0` | guard | fence | A1 on sub (13 steps) |
| `close.holdsN` | guard | fence | A1 on sub (13 steps) |
| `close.intent` | update | intent | L1 on one (0 steps) |
| `close.pc` | update | seq | L1 on two (0 steps) |

Pinned (bounds and world steps written as rules, never dropped or mutated): `fail.count`.

The smallest model on the verify bound: stopped at the state limit with no counterexample (3,000,001 states).

Dropped (no property breaks without them, given the rules kept): `begin.seq`, `begin.holds0`, `begin.holdsN`, `begin.tgt`, `begin.pc`, `adopt.noother`, `backoff.seq`, `backoff.holds0`, `backoff.holdsN`, `backoff.pc`, `retry.seq`, `retry.noother`, `retry.pc`, `skip.seq`, `skip.ended`, `skip.pc`, `step.raise`, `fail.fence`, `undo.fence`.

**Mutants:** 56; caught 41; equivalent 12; undecided 3; survived 0. Caught of non-equivalent: 41/44 (93%).

| mutant | kind | result |
|---|---|---|
| `claim.seq` | drop | ERR on one (3 steps) |
| `claim.free` | drop | undecided |
| `claim.lock` | drop | A1 on one (14 steps) |
| `claim.tok` | drop | L1 on one (0 steps) |
| `claim.pc` | drop | L1 on one (0 steps) |
| `begin.absent` | drop | A1 on one (16 steps) |
| `begin.noother` | drop | A2 on two (13 steps) |
| `begin.intent` | drop | L1 on one (0 steps) |
| `adopt.seq` | drop | A1 on one (10 steps) |
| `adopt.unfin` | drop | A1 on one (14 steps) |
| `adopt.tgt` | drop | ERR on one (5 steps) |
| `adopt.pc` | drop | L1 on one (0 steps) |
| `other.seq` | drop | L1 on two (4 steps) |
| `other.unfin` | drop | A2 on two (11 steps) |
| `other.tgt` | drop | ERR on two (5 steps) |
| `other.pc` | drop | L1 on two (2 steps) |
| `backoff.blocked` | drop | undecided |
| `backoff.release` | drop | L1 on sub (2 steps) |
| `step.seq` | drop | ERR on one (1 steps) |
| `step.fence` | drop | A1 on one (15 steps) |
| `step.data` | drop | A1 on one (7 steps) |
| `step.pc` | drop | L1 on one (5 steps) |
| `fail.seq` | drop | ERR on one (2 steps) |
| `fail.pc` | drop | L1 on one (5 steps) |
| `decide.seq` | drop | ERR on one (1 steps) |
| `decide.holds0` | drop | A1 on sub (13 steps) |
| `decide.holdsN` | drop | A1 on sub (13 steps) |
| `decide.intent` | drop | A1 on one (15 steps) |
| `decide.pc` | drop | L1 on one (5 steps) |
| `undo.seq` | drop | ERR on one (1 steps) |
| `undo.data` | drop | A1 on one (10 steps) |
| `undo.raise` | drop | A1 on one (15 steps) |
| `undo.pc` | drop | L1 on one (5 steps) |
| `giveup.lost` | drop | undecided |
| `giveup.release` | drop | L1 on one (4 steps) |
| `giveup.pc` | drop | L1 on one (4 steps) |
| `close.seq` | drop | ERR on one (1 steps) |
| `close.holds0` | drop | A1 on sub (13 steps) |
| `close.holdsN` | drop | A1 on sub (13 steps) |
| `close.intent` | drop | L1 on one (0 steps) |
| `close.pc` | drop | L1 on two (0 steps) |
| `step.fence` | flip | L1 on sub (5 steps) |
| `decide.holds0` | flip | L1 on one (5 steps) |
| `close.holds0` | flip | L1 on one (0 steps) |
| `claim: lock <-> tok` | swap | equivalent |
| `claim: lock <-> pc` | swap | equivalent |
| `claim: tok <-> pc` | swap | equivalent |
| `adopt: tgt <-> pc` | swap | equivalent |
| `other: tgt <-> pc` | swap | equivalent |
| `step: data <-> pc` | swap | equivalent |
| `decide: intent <-> pc` | swap | equivalent |
| `undo: data <-> raise` | swap | equivalent |
| `undo: data <-> pc` | swap | equivalent |
| `undo: raise <-> pc` | swap | equivalent |
| `giveup: release <-> pc` | swap | equivalent |
| `close: intent <-> pc` | swap | equivalent |

## ramp

Bounds (the design): two: 3,344 states; fol: 5,114 states; gc: 845 states; move: 1,008 states
Verify (the smallest model): fol-move: 184,512 states, holds; gc-move: 9,752 states, holds

**19 rules needed** of 42 written; by role: carry 2, mono 2, read 3, repair 1, seq 7, write 4.

Distinct checks (one guard repeated in several actions of one actor counted once): **19**; Raft's own guards (role raft: a working leader, one change at a time) among the 19: 0.

| rule | kind | role | removing it breaks |
|---|---|---|---|
| `prepare.vers` | update | write | KEEP on two (3 steps) |
| `prepare.ack` | update | seq | W on two (0 steps) |
| `commit.allprep` | guard | write | KEEP on two (1 steps) |
| `commit.newer` | guard | write | L on two (12 steps) |
| `commit.last` | update | write | W on two (0 steps) |
| `r1.unread` | guard | seq | R2 on two (8 steps) |
| `r1.mono` | guard | mono | MONO on fol (10 steps) |
| `r1.get` | update | read | L on two (0 steps) |
| `plan.all` | guard | seq | ERR on two (2 steps) |
| `plan.plan` | update | seq | L on two (0 steps) |
| `r2.stage` | guard | seq | R2 on two (1 steps) |
| `r2.get` | update | read | L on two (4 steps) |
| `r2.last` | update | repair | L on two (4 steps) |
| `finish.stage` | guard | seq | ERR on two (1 steps) |
| `finish.complete` | guard | read | RA on two (7 steps) |
| `finish.next` | update | seq | L on two (0 steps) |
| `finish.seen` | update | mono | MONO on fol (10 steps) |
| `move.pending` | update | carry | KEEP on move (3 steps) |
| `move.last` | update | carry | V on move (8 steps) |

Pinned (bounds and world steps written as rules, never dropped or mutated): `finish.ghost`, `move.fresh`.

Dropped (no property breaks without them, given the rules kept): `prepare.once`, `commit.once`, `commit.com`, `commit.ack`, `commitold.once`, `commitold.allprep`, `commitold.older`, `commitold.com`, `commitold.ack`, `r1.stage`, `plan.stage`, `r2.needs`, `r2.found`, `r2.commit`, `restart.stage`, `restart.needs`, `restart.gone`, `restart.reset`, `gc.older`, `gc.committed`, `gc.drop`, `move.committed`, `move.com`.

**Mutants:** 25; caught 20; equivalent 5; undecided 0; survived 0. Caught of non-equivalent: 20/20 (100%).

| mutant | kind | result |
|---|---|---|
| `prepare.vers` | drop | KEEP on two (3 steps) |
| `prepare.ack` | drop | W on two (0 steps) |
| `commit.allprep` | drop | KEEP on two (1 steps) |
| `commit.newer` | drop | L on two (12 steps) |
| `commit.last` | drop | W on two (0 steps) |
| `r1.unread` | drop | R2 on two (8 steps) |
| `r1.mono` | drop | MONO on fol (10 steps) |
| `r1.get` | drop | L on two (0 steps) |
| `plan.all` | drop | ERR on two (2 steps) |
| `plan.plan` | drop | L on two (0 steps) |
| `r2.stage` | drop | R2 on two (1 steps) |
| `r2.get` | drop | L on two (4 steps) |
| `r2.last` | drop | L on two (4 steps) |
| `finish.stage` | drop | ERR on two (1 steps) |
| `finish.complete` | drop | RA on two (7 steps) |
| `finish.next` | drop | L on two (0 steps) |
| `finish.seen` | drop | MONO on fol (10 steps) |
| `move.pending` | drop | KEEP on move (3 steps) |
| `move.last` | drop | V on move (8 steps) |
| `commit.newer` | flip | equivalent |
| `r1.mono` | flip | L on two (1 steps) |
| `prepare: vers <-> ack` | swap | equivalent |
| `r2: get <-> last` | swap | equivalent |
| `finish: next <-> seen` | swap | equivalent |
| `move: pending <-> last` | swap | equivalent |

