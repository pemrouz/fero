# results/found-ablation.json

## objcas

Bounds (the design): one1: 2,371 states; two0: 33,314 states; diff1: 1,923 states
Verify (the smallest model): one2: 10,767 states, holds; two1: 766,314 states, holds

**15 rules needed** of 19 written; by role: catalog 3, genesis 12.

Distinct checks (one guard repeated in several actions of one actor counted once): **15**; Raft's own guards (role raft: a working leader, one change at a time) among the 15: 0.

| rule | kind | role | removing it breaks |
|---|---|---|---|
| `cand.noid` | guard | genesis | G2.0 on one1 (5 steps) |
| `cand.keep` | update | genesis | G2.0 on one1 (2 steps) |
| `put.absent` | guard | genesis | G1 on one1 (10 steps) |
| `put.create` | update | genesis | G2.0 on one1 (2 steps) |
| `first.mine` | guard | genesis | G1 on one1 (8 steps) |
| `first.group` | update | genesis | SEED on one1 (5 steps) |
| `first.settings` | update | catalog | G2.0 on one1 (2 steps) |
| `first.seed` | update | catalog | G2.0 on one1 (2 steps) |
| `drop.other` | guard | genesis | G2.0 on one1 (5 steps) |
| `drop.drop` | update | genesis | G2.0 on one1 (4 steps) |
| `adopt.noid` | guard | genesis | G2.0 on one1 (5 steps) |
| `adopt.key` | guard | genesis | ISO on two0 (3 steps) |
| `adopt.stored` | guard | genesis | G2.0 on one1 (3 steps) |
| `adopt.adopt` | update | genesis | G2.0 on one1 (2 steps) |
| `join.same` | guard | catalog | CAT1 on diff1 (7 steps) |

Pinned (bounds and world steps written as rules, never dropped or mutated): `join.add`.

Put back by the verify bound: `first.mark` (put back: alone on one2 it breaks SEED in 5 steps; dropped again in the final pass after the verify); `reseed.unseeded` (put back: alone on one2 it breaks SEED in 5 steps; dropped again in the final pass after the verify).

Dropped (no property breaks without them, given the rules kept): `first.mark`, `reseed.unseeded`, `reseed.rows`, `reseed.mark`.

**Mutants:** 18; caught 15; equivalent 3; undecided 0; survived 0. Caught of non-equivalent: 15/15 (100%).

| mutant | kind | result |
|---|---|---|
| `cand.noid` | drop | G2.0 on one1 (5 steps) |
| `cand.keep` | drop | G2.0 on one1 (2 steps) |
| `put.absent` | drop | G1 on one1 (10 steps) |
| `put.create` | drop | G2.0 on one1 (2 steps) |
| `first.mine` | drop | G1 on one1 (8 steps) |
| `first.group` | drop | SEED on one1 (5 steps) |
| `first.settings` | drop | G2.0 on one1 (2 steps) |
| `first.seed` | drop | G2.0 on one1 (2 steps) |
| `drop.other` | drop | G2.0 on one1 (5 steps) |
| `drop.drop` | drop | G2.0 on one1 (4 steps) |
| `adopt.noid` | drop | G2.0 on one1 (5 steps) |
| `adopt.key` | drop | ISO on two0 (3 steps) |
| `adopt.stored` | drop | G2.0 on one1 (3 steps) |
| `adopt.adopt` | drop | G2.0 on one1 (2 steps) |
| `join.same` | drop | CAT1 on diff1 (7 steps) |
| `first: group <-> settings` | swap | equivalent |
| `first: group <-> seed` | swap | equivalent |
| `first: settings <-> seed` | swap | equivalent |

# results/catalog-ablation.json

## design

Bounds (the design): roll: 560 states
Verify (the smallest model): keys2: 252 states, holds

**6 rules needed** of 7 written; by role: catalog 6.

Distinct checks (one guard repeated in several actions of one actor counted once): **6**; Raft's own guards (role raft: a working leader, one change at a time) among the 6: 0.

| rule | kind | role | removing it breaks |
|---|---|---|---|
| `join.code` | guard | catalog | CAT3 on roll (2 steps) |
| `alteradd.entry` | update | catalog | ROLL on roll (0 steps) |
| `alterrm.rolled` | guard | catalog | AVAIL on roll (1 steps) |
| `alterrm.entry` | update | catalog | ROLL on roll (0 steps) |
| `write.gate` | guard | catalog | GATE on roll (3 steps) |
| `alterkey.consistent` | guard | catalog | KEYS on roll (1 steps) |

Pinned (bounds and world steps written as rules, never dropped or mutated): `join.serve`, `alterrm.stopold`, `write.w`, `alterkey.entry`.

Dropped (no property breaks without them, given the rules kept): `alterrm.after`.

**Mutants:** 7; caught 6; equivalent 0; undecided 0; survived 1. Caught of non-equivalent: 6/7 (86%).

| mutant | kind | result |
|---|---|---|
| `join.code` | drop | CAT3 on roll (2 steps) |
| `alteradd.entry` | drop | ROLL on roll (0 steps) |
| `alterrm.rolled` | drop | AVAIL on roll (1 steps) |
| `alterrm.entry` | drop | ROLL on roll (0 steps) |
| `write.gate` | drop | GATE on roll (3 steps) |
| `alterkey.consistent` | drop | KEYS on roll (1 steps) |
| `alterkey.consistent` | flip | SURVIVED |

# results/records-ablation.json

## design

Bounds (the design): e2: 626 states; m2: 385 states
Verify (the smallest model): e2m2: 28,198 states, holds

**4 rules needed** of 9 written; by role: records 4.

Distinct checks (one guard repeated in several actions of one actor counted once): **4**; Raft's own guards (role raft: a working leader, one change at a time) among the 4: 0.

| rule | kind | role | removing it breaks |
|---|---|---|---|
| `gc.shown` | guard | records | DUR on e2 (3 steps) |
| `delete.noslots` | guard | records | SLOT on e2 (2 steps) |
| `delete.safe` | guard | records | HIST on m2 (2 steps) |
| `resend.again` | update | records | REC on e2 (2 steps) |

Pinned (bounds and world steps written as rules, never dropped or mutated): `commit.apply`, `setrec.set`, `gc.delete`, `delete.drop`, `rewrite.seen`.

Dropped (no property breaks without them, given the rules kept): `commit.record`, `setrec.newer`, `delete.settled`, `rewrite.again`, `resend.differs`.

**Mutants:** 4; caught 4; equivalent 0; undecided 0; survived 0. Caught of non-equivalent: 4/4 (100%).

| mutant | kind | result |
|---|---|---|
| `gc.shown` | drop | DUR on e2 (3 steps) |
| `delete.noslots` | drop | SLOT on e2 (2 steps) |
| `delete.safe` | drop | HIST on m2 (2 steps) |
| `resend.again` | drop | REC on e2 (2 steps) |

# results/incarnation-ablation.json

## design

Bounds (the design): data2: 39 states; home3: 121 states
Verify (the smallest model): data3: 121 states, holds

**6 rules needed** of 6 written; by role: records 6.

Distinct checks (one guard repeated in several actions of one actor counted once): **6**; Raft's own guards (role raft: a working leader, one change at a time) among the 6: 0.

| rule | kind | role | removing it breaks |
|---|---|---|---|
| `recover.raise` | update | records | INC on data2 (4 steps) |
| `recover.record` | update | records | INC on data3 (5 steps) |
| `logstop.higher` | guard | records | INC on data2 (1 steps) |
| `logstop.stop` | update | records | INC on data3 (5 steps) |
| `hellostop.higher` | guard | records | INC on data2 (1 steps) |
| `hellostop.stop` | update | records | INC on home3 (4 steps) |

Pinned (bounds and world steps written as rules, never dropped or mutated): `recover.force`.

Put back by the verify bound: `recover.record` (put back: alone on data3 it breaks INC in 5 steps); `logstop.stop` (put back: alone on data3 it breaks INC in 5 steps); `logstop.higher` (put back: alone on data3 it breaks INC in 1 steps).

**Mutants:** 9; caught 8; equivalent 1; undecided 0; survived 0. Caught of non-equivalent: 8/8 (100%).

| mutant | kind | result |
|---|---|---|
| `recover.raise` | drop | INC on data2 (4 steps) |
| `recover.record` | drop | INC on data3 (5 steps) |
| `logstop.higher` | drop | INC on data2 (1 steps) |
| `logstop.stop` | drop | INC on data3 (5 steps) |
| `hellostop.higher` | drop | INC on data2 (1 steps) |
| `hellostop.stop` | drop | INC on home3 (4 steps) |
| `logstop.higher` | flip | INC on data2 (1 steps) |
| `hellostop.higher` | flip | INC on data2 (1 steps) |
| `recover: raise <-> record` | swap | equivalent |

# results/dirtable-ablation.json

## design

Bounds (the design): r1: 2,296 states; r2: 1,856 states; n2: 7,282 states
Verify (the smallest model): r2m: 16,722 states, holds; d2: 170,709 states, holds

**9 rules needed** of 11 written; by role: softdir 9.

Distinct checks (one guard repeated in several actions of one actor counted once): **9**; Raft's own guards (role raft: a working leader, one change at a time) among the 9: 0.

| rule | kind | role | removing it breaks |
|---|---|---|---|
| `connect.again` | update | softdir | REBUILD on r1 (0 steps) |
| `rconnect.open` | update | softdir | FIND.0 on r1 (0 steps) |
| `rconnect.again` | update | softdir | FIND.0 on r1 (0 steps) |
| `rconnect.take` | update | softdir | REBUILD on r1 (6 steps) |
| `announce.entry` | update | softdir | REBUILD on r1 (2 steps) |
| `expire.owner` | guard | softdir | REBUILD on r1 (7 steps) |
| `expire.drop` | update | softdir | REBUILD on r1 (2 steps) |
| `takeback.undo` | update | softdir | REBUILD on r1 (2 steps) |
| `takeover.host` | update | softdir | FIND.0 on r1 (1 steps) |

Pinned (bounds and world steps written as rules, never dropped or mutated): `connect.open`, `announce.clear`, `notice.close`.

Dropped (no property breaks without them, given the rules kept): `connect.take`, `takeback.owner`.

**Mutants:** 12; caught 11; equivalent 1; undecided 0; survived 0. Caught of non-equivalent: 11/11 (100%).

| mutant | kind | result |
|---|---|---|
| `connect.again` | drop | REBUILD on r1 (0 steps) |
| `rconnect.open` | drop | FIND.0 on r1 (0 steps) |
| `rconnect.again` | drop | FIND.0 on r1 (0 steps) |
| `rconnect.take` | drop | REBUILD on r1 (6 steps) |
| `announce.entry` | drop | REBUILD on r1 (2 steps) |
| `expire.owner` | drop | REBUILD on r1 (7 steps) |
| `expire.drop` | drop | REBUILD on r1 (2 steps) |
| `takeback.undo` | drop | REBUILD on r1 (2 steps) |
| `takeover.host` | drop | FIND.0 on r1 (1 steps) |
| `rconnect: open <-> again` | swap | FIND.0 on r1 (0 steps) |
| `rconnect: open <-> take` | swap | FIND.0 on r1 (0 steps) |
| `rconnect: again <-> take` | swap | equivalent |

# results/client-ablation.json

## design

Bounds (the design): c1: 3,202 states; c2: 2,031 states
Verify (the smallest model): c2m: 11,251 states, holds

**6 rules needed** of 8 written; by role: softdir 6.

Distinct checks (one guard repeated in several actions of one actor counted once): **6**; Raft's own guards (role raft: a working leader, one change at a time) among the 6: 0.

| rule | kind | role | removing it breaks |
|---|---|---|---|
| `miss.again` | update | softdir | FIND on c1 (1 steps) |
| `hello.proj` | guard | softdir | D1 on c2 (5 steps) |
| `hello.res` | guard | softdir | D1 on c1 (4 steps) |
| `hello.learn` | update | softdir | CONN on c1 (5 steps) |
| `reject.drop` | update | softdir | FIND on c1 (3 steps) |
| `refresh.learn` | update | softdir | CONN on c2m (7 steps) |

Pinned (bounds and world steps written as rules, never dropped or mutated): `lookup.pick`, `miss.fail`, `redial.pick`, `hello.conn`, `hello.tell`, `reject.wrong`, `dialfail.back`, `refresh.tell`.

Put back by the verify bound: `refresh.learn` (put back: alone on c2m it breaks CONN in 7 steps); `dialfail.mark` (put back: alone on c2m it breaks FIND in 5 steps; dropped again in the final pass after the verify).

Dropped (no property breaks without them, given the rules kept): `lookup.first`, `dialfail.mark`.

**Mutants:** 6; caught 6; equivalent 0; undecided 0; survived 0. Caught of non-equivalent: 6/6 (100%).

| mutant | kind | result |
|---|---|---|
| `miss.again` | drop | FIND on c1 (1 steps) |
| `hello.proj` | drop | D1 on c2 (5 steps) |
| `hello.res` | drop | D1 on c1 (4 steps) |
| `hello.learn` | drop | CONN on c1 (5 steps) |
| `reject.drop` | drop | FIND on c1 (3 steps) |
| `refresh.learn` | drop | CONN on c2m (7 steps) |

# results/place-ablation.json

## design

Bounds (the design): p1: 2,004 states; p1n: 1,124 states
Verify (the smallest model): p2: 25,062 states, holds; p2n: 43,904 states, holds

**5 rules needed** of 8 written; by role: catalog 1, heal 1, members 2, softdir 1.

Distinct checks (one guard repeated in several actions of one actor counted once): **5**; Raft's own guards (role raft: a working leader, one change at a time) among the 5: 0.

| rule | kind | role | removing it breaks |
|---|---|---|---|
| `mannounce.add` | update | softdir | HEAL on p1 (1 steps) |
| `leave.mark` | update | members | P7 on p1 (4 steps) |
| `add.live` | guard | heal | P9 on p1 (10 steps) |
| `add.code` | guard | catalog | CAT3 on p1n (3 steps) |
| `add.refuse` | guard | members | P7 on p1 (4 steps) |

Pinned (bounds and world steps written as rules, never dropped or mutated): `leave.count`, `add.put`.

Dropped (no property breaks without them, given the rules kept): `mannounce.notret`, `leave.exit`, `add.own`.

**Mutants:** 5; caught 5; equivalent 0; undecided 0; survived 0. Caught of non-equivalent: 5/5 (100%).

| mutant | kind | result |
|---|---|---|
| `mannounce.add` | drop | HEAL on p1 (1 steps) |
| `leave.mark` | drop | P7 on p1 (4 steps) |
| `add.live` | drop | P9 on p1 (10 steps) |
| `add.code` | drop | CAT3 on p1n (3 steps) |
| `add.refuse` | drop | P7 on p1 (4 steps) |

# results/place-stale-ablation.json

## stale

Bounds (the design): p1: 13,507 states; p1n: 8,226 states
Verify (the smallest model): p2: 195,858 states, holds; p2n: 375,464 states, holds

**5 rules needed** of 8 written; by role: catalog 1, heal 1, members 2, softdir 1.

Distinct checks (one guard repeated in several actions of one actor counted once): **5**; Raft's own guards (role raft: a working leader, one change at a time) among the 5: 0.

| rule | kind | role | removing it breaks |
|---|---|---|---|
| `mannounce.add` | update | softdir | HEAL on p1 (1 steps) |
| `leave.mark` | update | members | P7 on p1 (5 steps) |
| `add.live` | guard | heal | P9 on p1 (11 steps) |
| `add.code` | guard | catalog | CAT3 on p1n (4 steps) |
| `add.refuse` | guard | members | P7 on p1 (5 steps) |

Pinned (bounds and world steps written as rules, never dropped or mutated): `leave.count`, `add.put`.

Dropped (no property breaks without them, given the rules kept): `mannounce.notret`, `leave.exit`, `add.own`.

**Mutants:** 5; caught 5; equivalent 0; undecided 0; survived 0. Caught of non-equivalent: 5/5 (100%).

| mutant | kind | result |
|---|---|---|
| `mannounce.add` | drop | HEAL on p1 (1 steps) |
| `leave.mark` | drop | P7 on p1 (5 steps) |
| `add.live` | drop | P9 on p1 (11 steps) |
| `add.code` | drop | CAT3 on p1n (4 steps) |
| `add.refuse` | drop | P7 on p1 (5 steps) |

# results/fold-ablation.json

## v4

Bounds (the design): f1: 54 states; f2: 87 states
Verify (the smallest model): f3: 120 states, holds

**2 rules needed** of 2 written; by role: softdir 2.

Distinct checks (one guard repeated in several actions of one actor counted once): **2**; Raft's own guards (role raft: a working leader, one change at a time) among the 2: 0.

| rule | kind | role | removing it breaks |
|---|---|---|---|
| `register.pass` | update | softdir | REBUILD on f1 (4 steps) |
| `forget.grace` | guard | softdir | REBUILD on f1 (3 steps) |

Pinned (bounds and world steps written as rules, never dropped or mutated): `register.entry`, `fold.publish`, `fold.clean`, `forget.drop`.

**Mutants:** 3; caught 2; equivalent 1; undecided 0; survived 0. Caught of non-equivalent: 2/2 (100%).

| mutant | kind | result |
|---|---|---|
| `register.pass` | drop | REBUILD on f1 (4 steps) |
| `forget.grace` | drop | REBUILD on f1 (3 steps) |
| `forget.grace` | flip | equivalent |

