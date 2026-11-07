## objcas

Bounds (the design): any1: 750 states; any2: 3,598 states
Verify (the smallest model): any3: 4,606 states, holds

**4 rules needed** of 9 written; by role: found 2, join 2.

| rule | kind | role | removing it breaks |
|---|---|---|---|
| `found.absent` | guard | found | G1 on any1 (6 steps) |
| `found.create` | update | found | G2 on any1 (2 steps) |
| `adopt.stored` | guard | join | ERR on any1 (2 steps) |
| `adopt.adopt` | update | join | G2 on any1 (2 steps) |

Dropped (no property breaks without them, given the rules kept): `found.noid`, `adopt.noid`, `join.noid`, `join.hasid`, `join.adopt`.

**Mutants:** 4; caught 4; equivalent 0; undecided 0; survived 0. Caught of non-equivalent: 4/4 (100%).

| mutant | kind | result |
|---|---|---|
| `found.absent` | drop | G1 on any1 (6 steps) |
| `found.create` | drop | G2 on any1 (2 steps) |
| `adopt.stored` | drop | ERR on any1 (2 steps) |
| `adopt.adopt` | drop | G2 on any1 (2 steps) |

## init

Bounds (the design): any1: 206 states; any2: 942 states
Verify (the smallest model): any3: 2,840 states, holds

**3 rules needed** of 7 written; by role: found 2, join 1.

| rule | kind | role | removing it breaks |
|---|---|---|---|
| `init.once` | guard | found | G1 on any1 (8 steps) |
| `init.mint` | update | found | G2 on any1 (2 steps) |
| `join.adopt` | update | join | G2 on any1 (3 steps) |

Dropped (no property breaks without them, given the rules kept): `init.majority`, `init.noid`, `join.noid`, `join.hasid`.

**Mutants:** 3; caught 3; equivalent 0; undecided 0; survived 0. Caught of non-equivalent: 3/3 (100%).

| mutant | kind | result |
|---|---|---|
| `init.once` | drop | G1 on any1 (8 steps) |
| `init.mint` | drop | G2 on any1 (2 steps) |
| `join.adopt` | drop | G2 on any1 (3 steps) |

## unanimous

Bounds (the design): any1: 56 states; any2: 294 states
Verify (the smallest model): any3: 546 states, holds

**5 rules needed** of 6 written; by role: found 3, join 2.

| rule | kind | role | removing it breaks |
|---|---|---|---|
| `found.all` | guard | found | G1 on any2 (10 steps) |
| `found.noid` | guard | found | G2all on any3 (12 steps) |
| `found.mint` | update | found | G2all on any1 (3 steps) |
| `join.hasid` | guard | join | G2all on any3 (18 steps) |
| `join.adopt` | update | join | G2all on any2 (8 steps) |

Dropped (no property breaks without them, given the rules kept): `join.noid`.

**Mutants:** 6; caught 6; equivalent 0; undecided 0; survived 0. Caught of non-equivalent: 6/6 (100%).

| mutant | kind | result |
|---|---|---|
| `found.all` | drop | G1 on any2 (10 steps) |
| `found.noid` | drop | G2all on any3 (12 steps) |
| `found.mint` | drop | G2all on any1 (3 steps) |
| `join.hasid` | drop | G2all on any3 (18 steps) |
| `join.adopt` | drop | G2all on any2 (8 steps) |
| `found.all` | flip | G2all on any1 (3 steps) |

## draft

Bounds (the design): one1: 784 states; one2: 2,584 states; one3: 6,592 states

**4 rules needed** of 12 written; by role: join 1, stale 3.

| rule | kind | role | removing it breaks |
|---|---|---|---|
| `join.join` | update | join | G2 on one1 (4 steps) |
| `stale.nometa` | guard | stale | G1 on one1 (6 steps) |
| `stale.readable` | guard | stale | G1 on one1 (7 steps) |
| `stale.refound` | update | stale | G2 on one1 (4 steps) |

Pinned (bounds and world steps written as rules, never dropped or mutated): `join.member`.

Dropped (no property breaks without them, given the rules kept): `create.nofile`, `create.nodir`, `create.create`, `join.nodir`, `stale.file`, `stale.nodir`, `stale.nomember`, `stale.unlocked`.

**Mutants:** 4; caught 4; equivalent 0; undecided 0; survived 0. Caught of non-equivalent: 4/4 (100%).

| mutant | kind | result |
|---|---|---|
| `join.join` | drop | G2 on one1 (4 steps) |
| `stale.nometa` | drop | G1 on one1 (6 steps) |
| `stale.readable` | drop | G1 on one1 (7 steps) |
| `stale.refound` | drop | G2 on one1 (4 steps) |

## design

Bounds (the design): b1: 640 states; b2: 1,184 states; b3: 8,868 states

**8 rules needed** of 11 written; by role: cursor 1, dedup 1, epoch 2, session 2, stamp 2.

| rule | kind | role | removing it breaks |
|---|---|---|---|
| `write.session` | guard | session | R3 on b1 (5 steps) |
| `write.dedup` | guard | dedup | R3 on b1 (3 steps) |
| `write.seq` | update | stamp | R1 on b1 (3 steps) |
| `lock.seq` | update | stamp | R1 on b1 (3 steps) |
| `move.hw` | update | epoch | R2 on b1 (5 steps) |
| `restore.epoch` | update | epoch | R2 on b1 (4 steps) |
| `restore.sgen` | update | session | R3 on b1 (5 steps) |
| `read.known` | guard | cursor | R4 on b1 (6 steps) |

Pinned (bounds and world steps written as rules, never dropped or mutated): `write.stamp`, `lock.one`, `lock.stamp`, `move.one`, `move.epoch`, `restore.budget`, `restore.world`, `read.take`.

Dropped (no property breaks without them, given the rules kept): `restore.hw`, `refused.unknown`, `refused.reset`.

**Mutants:** 9; caught 8; equivalent 1; undecided 0; survived 0. Caught of non-equivalent: 8/8 (100%).

| mutant | kind | result |
|---|---|---|
| `write.session` | drop | R3 on b1 (5 steps) |
| `write.dedup` | drop | R3 on b1 (3 steps) |
| `write.seq` | drop | R1 on b1 (3 steps) |
| `lock.seq` | drop | R1 on b1 (3 steps) |
| `move.hw` | drop | R2 on b1 (5 steps) |
| `restore.epoch` | drop | R2 on b1 (4 steps) |
| `restore.sgen` | drop | R3 on b1 (5 steps) |
| `read.known` | drop | R4 on b1 (6 steps) |
| `restore: epoch <-> sgen` | swap | equivalent |

