## view

Bounds (the design): fo: 129,355 states; mv: 313,416 states; big: 70,483 states; ring2: 85,666 states; fifo: 156,832 states; bfo: 136,072 states
Verify (the smallest model): fo2: 476,689 states, holds; mvf: 409,554 states, holds

**44 rules needed** of 90 written; by role: answer 5, end 4, place 4, pos 1, replace 2, ring 2, seen 3, seq 13, serve 5, write 5.

Distinct checks (one guard repeated in several actions of one actor counted once): **44**; Raft's own guards (role raft: a working leader, one change at a time) among the 44: 0.

| rule | kind | role | removing it breaks |
|---|---|---|---|
| `notready.unready` | guard | answer | undecided (big: state limit) |
| `notready.send` | update | answer | P5 on mv (2 steps) |
| `moved.notowner` | guard | place | undecided (big: state limit) |
| `moved.send` | update | answer | P5 on fo (1 steps) |
| `build.owner` | guard | place | PL2 on fo (2 steps) |
| `build.none` | guard | seq | undecided (fo: state limit) |
| `build.ent` | update | serve | undecided (fo: state limit) |
| `pic.owner` | guard | place | PL1 on fo (4 steps) |
| `pic.live` | guard | serve | E3 on big (9 steps) |
| `pic.seen` | guard | seen | P9 on fo (8 steps) |
| `pic.send` | update | serve | P5 on fo (0 steps) |
| `pic.rec` | update | ring | undecided (fo2: state limit) |
| `frm.owner` | guard | place | PL1 on fo (6 steps) |
| `frm.live` | guard | serve | E3 on big (9 steps) |
| `frm.behind` | guard | serve | undecided (fo: state limit) |
| `frm.rec` | update | ring | undecided (fo2: state limit) |
| `endbig.ended` | guard | end | E1 on fo (2 steps) |
| `endbig.send` | update | end | P5 on big (2 steps) |
| `gotpic.is` | guard | seq | ERR on fo (3 steps) |
| `gotpic.clear` | update | replace | V1 on fo (15 steps) |
| `gotpic.rows` | update | replace | V1 on fo (7 steps) |
| `gotpic.pos` | update | pos | V1 on fo (7 steps) |
| `gotpic.seen` | update | seen | P9 on fo (11 steps) |
| `gotpic.credit` | update | seq | P5 on fo (3 steps) |
| `gotfrm.is` | guard | seq | P5 on fo (3 steps) |
| `gotfrm.credit` | update | seq | undecided (fo2: state limit) |
| `gotgap.is` | guard | seq | ERR on fo (3 steps) |
| `gotgap.gap` | guard | seq | undecided (fo2: state limit) |
| `gotmoved.is` | guard | seq | undecided (big: state limit) |
| `gotmoved.leave` | update | answer | P5 on fo (1 steps) |
| `gotmoved.credit` | update | seq | undecided (big: state limit) |
| `gotretry.is` | guard | seq | undecided (big: state limit) |
| `gotretry.leave` | update | answer | P5 on fo (3 steps) |
| `gotretry.credit` | update | seq | undecided (big: state limit) |
| `gotbig.is` | guard | seq | E1 on fo (3 steps) |
| `gotbig.ended` | update | end | P5 on big (2 steps) |
| `connect.open` | guard | end | E2 on big (12 steps) |
| `connect.link` | update | seq | P5 on fo (0 steps) |
| `ack.committed` | guard | write | P4 on fo (6 steps) |
| `ack.seen` | update | seen | P9 on fo (8 steps) |
| `ack.acked` | update | write | P5 on fo (0 steps) |
| `resolve.acked` | guard | write | P4 on fo (5 steps) |
| `resolve.seen` | guard | write | P4 on fo (6 steps) |
| `resolve.res` | update | write | P5 on fo (0 steps) |

Pinned (bounds and world steps written as rules, never dropped or mutated): `frm.ring`, `bopen.phase`.

Dropped (no property breaks without them, given the rules kept): `moved.loaded`, `moved.holds`, `build.loaded`, `build.holds`, `build.ctr`, `pic.loaded`, `pic.holds`, `res.req`, `res.loaded`, `res.holds`, `res.owner`, `res.live`, `res.inst`, `res.ring`, `res.ahead`, `res.send`, `res.rec`, `frm.on`, `frm.loaded`, `frm.holds`, `frm.inst`, `frm.send`, `dispose.stays`, `dispose.drop`, `gotpic.inst`, `gotpic.seq`, `skip.old`, `skip.trim`, `gotres.is`, `gotres.fresh`, `gotres.apply`, `gotres.seq`, `gotres.pos`, `gotres.seen`, `gotres.credit`, `gotfrm.next`, `gotfrm.apply`, `gotfrm.seq`, `gotfrm.pos`, `gotfrm.seen`, `gotgap.leave`, `gotgap.credit`, `gotbig.leave`, `gotbig.credit`, `connect.alive`, `bopen.fold`.

**Mutants:** 61; caught 40; equivalent 7; undecided 13; survived 1. Caught of non-equivalent: 40/54 (74%).

| mutant | kind | result |
|---|---|---|
| `notready.unready` | drop | undecided |
| `notready.send` | drop | P5 on mv (2 steps) |
| `moved.notowner` | drop | undecided |
| `moved.send` | drop | P5 on fo (1 steps) |
| `build.owner` | drop | PL2 on fo (2 steps) |
| `build.none` | drop | undecided |
| `build.ent` | drop | undecided |
| `pic.owner` | drop | PL1 on fo (4 steps) |
| `pic.live` | drop | E3 on big (9 steps) |
| `pic.seen` | drop | P9 on fo (8 steps) |
| `pic.send` | drop | P5 on fo (0 steps) |
| `pic.rec` | drop | undecided |
| `frm.owner` | drop | PL1 on fo (6 steps) |
| `frm.live` | drop | E3 on big (9 steps) |
| `frm.behind` | drop | undecided |
| `frm.rec` | drop | undecided |
| `endbig.ended` | drop | E1 on fo (2 steps) |
| `endbig.send` | drop | P5 on big (2 steps) |
| `gotpic.is` | drop | ERR on fo (3 steps) |
| `gotpic.clear` | drop | V1 on fo (15 steps) |
| `gotpic.rows` | drop | V1 on fo (7 steps) |
| `gotpic.pos` | drop | V1 on fo (7 steps) |
| `gotpic.seen` | drop | P9 on fo (11 steps) |
| `gotpic.credit` | drop | P5 on fo (3 steps) |
| `gotfrm.is` | drop | P5 on fo (3 steps) |
| `gotfrm.credit` | drop | undecided |
| `gotgap.is` | drop | ERR on fo (3 steps) |
| `gotgap.gap` | drop | undecided |
| `gotmoved.is` | drop | undecided |
| `gotmoved.leave` | drop | P5 on fo (1 steps) |
| `gotmoved.credit` | drop | undecided |
| `gotretry.is` | drop | undecided |
| `gotretry.leave` | drop | P5 on fo (3 steps) |
| `gotretry.credit` | drop | undecided |
| `gotbig.is` | drop | E1 on fo (3 steps) |
| `gotbig.ended` | drop | P5 on big (2 steps) |
| `connect.open` | drop | E2 on big (12 steps) |
| `connect.link` | drop | P5 on fo (0 steps) |
| `ack.committed` | drop | P4 on fo (6 steps) |
| `ack.seen` | drop | P9 on fo (8 steps) |
| `ack.acked` | drop | P5 on fo (0 steps) |
| `resolve.acked` | drop | P4 on fo (5 steps) |
| `resolve.seen` | drop | P4 on fo (6 steps) |
| `resolve.res` | drop | P5 on fo (0 steps) |
| `pic.seen` | flip | P5 on fo (7 steps) |
| `frm.behind` | flip | SURVIVED |
| `resolve.seen` | flip | P5 on fo (6 steps) |
| `pic: send <-> rec` | swap | equivalent |
| `gotpic: clear <-> rows` | swap | V1 on fo (7 steps) |
| `gotpic: clear <-> pos` | swap | V1 on fo (7 steps) |
| `gotpic: clear <-> seen` | swap | V1 on fo (7 steps) |
| `gotpic: clear <-> credit` | swap | V1 on fo (7 steps) |
| `gotpic: rows <-> pos` | swap | equivalent |
| `gotpic: rows <-> seen` | swap | P9 on fo (11 steps) |
| `gotpic: rows <-> credit` | swap | equivalent |
| `gotpic: pos <-> seen` | swap | P9 on fo (11 steps) |
| `gotpic: pos <-> credit` | swap | P9 on fo (11 steps) |
| `gotpic: seen <-> credit` | swap | equivalent |
| `gotmoved: leave <-> credit` | swap | equivalent |
| `gotretry: leave <-> credit` | swap | equivalent |
| `ack: seen <-> acked` | swap | equivalent |

## fold

Bounds (the design): fo: 96,837 states; mv: 327,908 states; tw: 349,571 states
Verify (the smallest model): fo2: 65,726 states, holds

**17 rules needed** of 47 written; by role: answer 2, base 2, carry 1, cursor 2, ready 1, replace 2, seq 3, serve 1, write 3.

Distinct checks (one guard repeated in several actions of one actor counted once): **17**; Raft's own guards (role raft: a working leader, one change at a time) among the 17: 0.

| rule | kind | role | removing it breaks |
|---|---|---|---|
| `snap.loaded` | guard | ready | P3 on fo (2 steps) |
| `snap.cursor` | guard | cursor | P6 on fo (10 steps) |
| `snap.send` | update | serve | P5 on fo (0 steps) |
| `notready.send` | update | answer | P5 on fo (1 steps) |
| `gotsnap.is` | guard | seq | ERR on fo (3 steps) |
| `gotsnap.clear` | update | replace | P2 on fo (16 steps) |
| `gotsnap.rows` | update | replace | P2 on fo (6 steps) |
| `gotsnap.cursor` | update | cursor | P2 on fo (6 steps) |
| `gotretry.leave` | update | answer | P5 on fo (1 steps) |
| `gotretry.credit` | update | seq | P5 on fo (1 steps) |
| `connect.link` | update | seq | P5 on fo (0 steps) |
| `save.rows` | update | base | P2 on fo (8 steps) |
| `save.cur` | update | base | P2 on fo (8 steps) |
| `resolve.committed` | guard | write | P4 on fo (5 steps) |
| `resolve.seen` | guard | write | P4 on fo (5 steps) |
| `resolve.res` | update | write | P5 on fo (0 steps) |
| `bopen.fold` | update | carry | P5 on mv (1 steps) |

Pinned (bounds and world steps written as rules, never dropped or mutated): `diff.held`, `load.rows`, `gc.drop`, `bopen.phase`.

Dropped (no property breaks without them, given the rules kept): `snap.req`, `snap.holds`, `diff.req`, `diff.loaded`, `diff.holds`, `diff.behind`, `diff.send`, `fres.req`, `fres.loaded`, `fres.holds`, `fres.cursor`, `fres.window`, `fres.send`, `notready.unready`, `gotsnap.credit`, `gotdiff.is`, `gotdiff.add`, `gotdiff.del`, `gotdiff.cursor`, `gotdiff.credit`, `gotfres.is`, `gotfres.add`, `gotfres.del`, `gotfres.cursor`, `gotfres.credit`, `gotretry.is`, `connect.alive`, `load.floor`, `gc.floor`, `bopen.floor`.

**Mutants:** 24; caught 20; equivalent 3; undecided 0; survived 1. Caught of non-equivalent: 20/21 (95%).

| mutant | kind | result |
|---|---|---|
| `snap.loaded` | drop | P3 on fo (2 steps) |
| `snap.cursor` | drop | P6 on fo (10 steps) |
| `snap.send` | drop | P5 on fo (0 steps) |
| `notready.send` | drop | P5 on fo (1 steps) |
| `gotsnap.is` | drop | ERR on fo (3 steps) |
| `gotsnap.clear` | drop | P2 on fo (16 steps) |
| `gotsnap.rows` | drop | P2 on fo (6 steps) |
| `gotsnap.cursor` | drop | P2 on fo (6 steps) |
| `gotretry.leave` | drop | P5 on fo (1 steps) |
| `gotretry.credit` | drop | P5 on fo (1 steps) |
| `connect.link` | drop | P5 on fo (0 steps) |
| `save.rows` | drop | P2 on fo (8 steps) |
| `save.cur` | drop | P2 on fo (8 steps) |
| `resolve.committed` | drop | P4 on fo (5 steps) |
| `resolve.seen` | drop | P4 on fo (5 steps) |
| `resolve.res` | drop | P5 on fo (0 steps) |
| `bopen.fold` | drop | P5 on mv (1 steps) |
| `snap.cursor` | flip | SURVIVED |
| `resolve.seen` | flip | P5 on fo (6 steps) |
| `gotsnap: clear <-> rows` | swap | P2 on fo (6 steps) |
| `gotsnap: clear <-> cursor` | swap | P2 on fo (6 steps) |
| `gotsnap: rows <-> cursor` | swap | equivalent |
| `gotretry: leave <-> credit` | swap | equivalent |
| `save: rows <-> cur` | swap | equivalent |

## view: each rule alone, and where it is already counted

Rules written: 90 (and 2 pinned). Needed alone in the full design (dropping it alone breaks a property on a sweep bound, or stops at the state limit there): **62**. Kept in the smallest model (DEV-10): **44**.

- kept in the smallest model, by where each is already counted: e31 24, tf 13, new 7.
- needed alone in the full design, by where each is already counted: e31 28, read 5, tf 20, new 9.

| rule | counted in | in the smallest model | dropped alone from the full design |
|---|---|---|---|
| `notready.unready` | e31 | kept | undecided (state limit) |
| `notready.send` | e31 | kept | P5 on mv (2 steps) |
| `moved.loaded` | tf | dropped | holds |
| `moved.holds` | tf | dropped | holds |
| `moved.notowner` | tf | kept | undecided (state limit) |
| `moved.send` | tf | kept | P5 on fo (1 steps) |
| `build.loaded` | e31 | dropped | holds |
| `build.holds` | e31 | dropped | holds |
| `build.owner` | tf | kept | PL2 on fo (2 steps) |
| `build.none` | tf | kept | undecided (state limit) |
| `build.ctr` | tf | dropped | V1 on big (13 steps) |
| `build.ent` | tf | kept | undecided (state limit) |
| `pic.loaded` | e31 | dropped | holds |
| `pic.holds` | e31 | dropped | holds |
| `pic.owner` | tf | kept | PL1 on fo (4 steps) |
| `pic.live` | tf | kept | E3 on big (9 steps) |
| `pic.seen` | e31 | kept | P9 on fo (8 steps) |
| `pic.send` | e31 | kept | V1 on fo (8 steps) |
| `pic.rec` | tf | kept | undecided (state limit) |
| `res.req` | tf | dropped | holds |
| `res.loaded` | tf | dropped | holds |
| `res.holds` | tf | dropped | holds |
| `res.owner` | tf | dropped | PL1 on fo (9 steps) |
| `res.live` | tf | dropped | E3 on big (13 steps) |
| `res.inst` | tf | dropped | V1 on fo (7 steps) |
| `res.ring` | tf | dropped | V1 on fo (14 steps) |
| `res.ahead` | tf | dropped | holds |
| `res.send` | tf | dropped | holds |
| `res.rec` | tf | dropped | holds |
| `frm.on` | e31 | dropped | holds |
| `frm.loaded` | e31 | dropped | holds |
| `frm.holds` | e31 | dropped | holds |
| `frm.owner` | tf | kept | PL1 on fo (8 steps) |
| `frm.live` | tf | kept | E3 on big (11 steps) |
| `frm.inst` | tf | dropped | holds |
| `frm.behind` | e31 | kept | V1 on fo (11 steps) |
| `frm.send` | e31 | dropped | holds |
| `frm.rec` | tf | kept | undecided (state limit) |
| `endbig.ended` | tf | kept | E1 on fo (2 steps) |
| `endbig.send` | tf | kept | P5 on big (2 steps) |
| `dispose.stays` | tf | dropped | holds |
| `dispose.drop` | tf | dropped | holds |
| `gotpic.is` | e31 | kept | ERR on fo (3 steps) |
| `gotpic.clear` | e31 | kept | V1 on fo (15 steps) |
| `gotpic.rows` | e31 | kept | V1 on fo (7 steps) |
| `gotpic.pos` | e31 | kept | V1 on fo (7 steps) |
| `gotpic.inst` | new | dropped | holds |
| `gotpic.seq` | read | dropped | D1 on fo (11 steps) |
| `gotpic.seen` | new | kept | P9 on fo (11 steps) |
| `gotpic.credit` | e31 | kept | P5 on fo (3 steps) |
| `skip.old` | read | dropped | holds |
| `skip.trim` | read | dropped | P5 on fifo (11 steps) |
| `gotres.is` | tf | dropped | ERR on fo (3 steps) |
| `gotres.fresh` | read | dropped | D1 on fifo (13 steps) |
| `gotres.apply` | tf | dropped | V1 on fo (11 steps) |
| `gotres.seq` | read | dropped | D1 on ring2 (19 steps) |
| `gotres.pos` | e31 | dropped | V1 on fo (11 steps) |
| `gotres.seen` | new | dropped | P9 on fo2 (15 steps) |
| `gotres.credit` | e31 | dropped | P5 on fo (7 steps) |
| `gotfrm.is` | e31 | kept | ERR on fo (3 steps) |
| `gotfrm.next` | read | dropped | holds |
| `gotfrm.apply` | e31 | dropped | V1 on fo (9 steps) |
| `gotfrm.seq` | read | dropped | D1 on fo (13 steps) |
| `gotfrm.pos` | e31 | dropped | V1 on fo (9 steps) |
| `gotfrm.seen` | new | dropped | P9 on fo (13 steps) |
| `gotfrm.credit` | e31 | kept | undecided (state limit) |
| `gotgap.is` | new | kept | ERR on fo (3 steps) |
| `gotgap.gap` | new | kept | undecided (state limit) |
| `gotgap.leave` | new | dropped | holds |
| `gotgap.credit` | new | dropped | holds |
| `gotmoved.is` | e31 | kept | undecided (state limit) |
| `gotmoved.leave` | e31 | kept | P5 on fo (1 steps) |
| `gotmoved.credit` | e31 | kept | undecided (state limit) |
| `gotretry.is` | e31 | kept | undecided (state limit) |
| `gotretry.leave` | e31 | kept | P5 on fo (3 steps) |
| `gotretry.credit` | e31 | kept | undecided (state limit) |
| `gotbig.is` | new | kept | E1 on fo (3 steps) |
| `gotbig.ended` | new | kept | P5 on big (2 steps) |
| `gotbig.leave` | e31 | dropped | holds |
| `gotbig.credit` | e31 | dropped | holds |
| `connect.alive` | e31 | dropped | holds |
| `connect.open` | new | kept | E2 on big (11 steps) |
| `connect.link` | e31 | kept | P5 on fo (0 steps) |
| `ack.committed` | e31 | kept | P4 on fo (6 steps) |
| `ack.seen` | new | kept | P9 on fo (8 steps) |
| `ack.acked` | e31 | kept | P5 on fo (0 steps) |
| `resolve.acked` | e31 | kept | P4 on fo (5 steps) |
| `resolve.seen` | e31 | kept | P4 on fo (6 steps) |
| `resolve.res` | e31 | kept | P5 on fo (0 steps) |
| `bopen.fold` | e31 | dropped | holds |

**Planted bugs:** 7 of 8 caught.

| planted bug | result |
|---|---|
| `copyinst` | V1 on fo (12 steps) |
| `incinst` | V1 on fo (12 steps) |
| `framepos` | V1 on ring2 (12 steps) |
| `ownseq` | D1 on fo (11 steps) |
| `leadserve` | PL1 on fo (4 steps) |
| `noinst` | SURVIVED |
| `endatfold` | E3 on big (12 steps) |
| `picfits` | E3 on big (12 steps) |

## resume: each rule alone, and where it is already counted

Rules written: 47 (and 4 pinned). Needed alone in the full design (dropping it alone breaks a property on a sweep bound, or stops at the state limit there): **30**. Kept in the smallest model (DEV-10): **17**.

- kept in the smallest model, by where each is already counted: e31 15, new 2.
- needed alone in the full design, by where each is already counted: e31 17, new 13.

| rule | counted in | in the smallest model | dropped alone from the full design |
|---|---|---|---|
| `snap.req` | e31 | dropped | holds |
| `snap.loaded` | e31 | kept | P3 on fo (3 steps) |
| `snap.holds` | e31 | dropped | holds |
| `snap.cursor` | e31 | kept | P6 on fo (10 steps) |
| `snap.send` | e31 | kept | P5 on fo (5 steps) |
| `diff.req` | e31 | dropped | holds |
| `diff.loaded` | e31 | dropped | holds |
| `diff.holds` | e31 | dropped | holds |
| `diff.behind` | e31 | dropped | holds |
| `diff.send` | e31 | dropped | holds |
| `fres.req` | new | dropped | holds |
| `fres.loaded` | new | dropped | P3 on fo (3 steps) |
| `fres.holds` | new | dropped | holds |
| `fres.cursor` | new | dropped | P2 on fo (10 steps) |
| `fres.window` | new | dropped | P2 on fo (14 steps) |
| `fres.send` | new | dropped | holds |
| `notready.unready` | e31 | dropped | holds |
| `notready.send` | e31 | kept | P5 on fo (1 steps) |
| `gotsnap.is` | e31 | kept | ERR on fo (3 steps) |
| `gotsnap.clear` | e31 | kept | P2 on fo (14 steps) |
| `gotsnap.rows` | e31 | kept | P2 on fo (6 steps) |
| `gotsnap.cursor` | e31 | kept | P2 on fo (6 steps) |
| `gotsnap.credit` | e31 | dropped | P5 on fo (2 steps) |
| `gotdiff.is` | e31 | dropped | ERR on fo (3 steps) |
| `gotdiff.add` | e31 | dropped | holds |
| `gotdiff.del` | e31 | dropped | holds |
| `gotdiff.cursor` | e31 | dropped | holds |
| `gotdiff.credit` | e31 | dropped | holds |
| `gotfres.is` | new | dropped | F1 on fo (3 steps) |
| `gotfres.add` | new | dropped | P2 on fo (6 steps) |
| `gotfres.del` | new | dropped | P2 on fo (14 steps) |
| `gotfres.cursor` | new | dropped | P2 on fo (6 steps) |
| `gotfres.credit` | new | dropped | P5 on fo (2 steps) |
| `gotretry.is` | e31 | dropped | holds |
| `gotretry.leave` | e31 | kept | P5 on fo (1 steps) |
| `gotretry.credit` | e31 | kept | P5 on fo (1 steps) |
| `connect.alive` | e31 | dropped | holds |
| `connect.link` | e31 | kept | P5 on fo (0 steps) |
| `save.rows` | new | kept | P2 on fo (8 steps) |
| `save.cur` | new | kept | P2 on fo (8 steps) |
| `load.floor` | new | dropped | P2 on fo (14 steps) |
| `gc.floor` | new | dropped | P2 on fo (15 steps) |
| `resolve.committed` | e31 | kept | P4 on fo (5 steps) |
| `resolve.seen` | e31 | kept | P4 on fo (5 steps) |
| `resolve.res` | e31 | kept | P5 on fo (0 steps) |
| `bopen.fold` | e31 | kept | P5 on mv (1 steps) |
| `bopen.floor` | new | dropped | P2 on mv (16 steps) |

**Planted bugs:** 2 of 2 caught.

| planted bug | result |
|---|---|
| `torn` | P2 on fo (8 steps) |
| `firstver` | P2 on tw (16 steps) |

