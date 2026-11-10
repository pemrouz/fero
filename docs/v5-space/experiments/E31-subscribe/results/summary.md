## fixed

Bounds (the design): fo-log: 5,467 states; fo-state: 8,081 states; mv-log: 18,646 states; mv-state: 24,989 states; rl-log: 54,404 states; rl-state: 390,164 states
Verify (the smallest model): fo2-state: 90,711 states, holds; fo2-log: 68,172 states, holds; mvrl-log: 871,859 states, holds

**26 rules needed** of 62 written; by role: answer 5, carry 1, cursor 3, ready 2, replace 2, seq 6, serve 4, write 3.

Distinct checks (one guard repeated in several actions of one actor counted once): **26**; Raft's own guards (role raft: a working leader, one change at a time) among the 26: 0.

| rule | kind | role | removing it breaks |
|---|---|---|---|
| `snap.loaded` | guard | ready | P3 on fo2-state (2 steps) |
| `snap.cursor` | guard | cursor | P6 on fo2-state (10 steps) |
| `snap.send` | update | serve | P5 on fo2-state (4 steps) |
| `rec.loaded` | guard | ready | P3 on fo2-state (6 steps) |
| `rec.committed` | guard | serve | ERR on fo2-state (3 steps) |
| `rec.send` | update | serve | P5 on fo2-log (0 steps) |
| `notready.send` | update | answer | P5 on fo2-state (1 steps) |
| `expire.lost` | guard | answer | P7 on fo2-log (3 steps) |
| `expire.send` | update | answer | P5 on fo2-log (4 steps) |
| `gotsnap.is` | guard | seq | ERR on fo2-state (3 steps) |
| `gotsnap.clear` | update | replace | P2 on fo2-state (14 steps) |
| `gotsnap.rows` | update | replace | P2 on fo2-state (6 steps) |
| `gotsnap.cursor` | update | cursor | P2 on fo2-state (6 steps) |
| `gotrec.is` | guard | seq | ERR on fo2-state (3 steps) |
| `gotrec.apply` | update | serve | P2 on fo2-state (6 steps) |
| `gotrec.cursor` | update | cursor | P2 on fo2-state (6 steps) |
| `gotrec.credit` | update | seq | P1 on fo2-log (7 steps) |
| `gotretry.leave` | update | answer | P5 on fo2-state (1 steps) |
| `gotretry.credit` | update | seq | P5 on fo2-state (1 steps) |
| `gotexp.is` | guard | seq | P7 on fo2-log (3 steps) |
| `gotexp.dead` | update | answer | P5 on fo2-log (4 steps) |
| `connect.link` | update | seq | P5 on fo2-state (0 steps) |
| `bopen.fold` | update | carry | P5 on fo2-state (1 steps) |
| `resolve.committed` | guard | write | P4 on fo2-state (5 steps) |
| `resolve.seen` | guard | write | P4 on fo2-state (5 steps) |
| `resolve.res` | update | write | P5 on fo2-state (0 steps) |

Pinned (bounds and world steps written as rules, never dropped or mutated): `diff.held`, `open.held`, `rec.held`, `bopen.phase`.

Put back by the verify bound: `group snapshot: snap.req, snap.loaded, snap.holds, snap.cursor, snap.send, gotsnap.is, gotsnap.clear, gotsnap.rows, gotsnap.cursor, gotsnap.loaded, gotsnap.credit` (put back as a group: without it the smallest sweep model breaks P5 on fo2-state in 4 steps); `group expired: expire.on, expire.loaded, expire.lost, expire.send, gotexp.is, gotexp.dead, gotexp.leave, gotexp.credit` (put back as a group: without it the smallest sweep model breaks P5 on fo2-state in 4 steps).

Dropped (no property breaks without them, given the rules kept): `snap.req`, `snap.holds`, `diff.req`, `diff.loaded`, `diff.holds`, `diff.behind`, `diff.send`, `open.req`, `open.loaded`, `open.holds`, `open.on`, `rec.on`, `rec.holds`, `moved.notholds`, `moved.send`, `notready.unready`, `expire.on`, `expire.loaded`, `gotsnap.loaded`, `gotsnap.credit`, `gotdiff.is`, `gotdiff.add`, `gotdiff.del`, `gotdiff.cursor`, `gotdiff.credit`, `gotmoved.is`, `gotmoved.leave`, `gotmoved.credit`, `gotretry.is`, `gotend.is`, `gotend.leave`, `gotend.credit`, `gotexp.leave`, `gotexp.credit`, `connect.alive`, `bopen.segs`.

**Mutants:** 37; caught 31; equivalent 5; undecided 0; survived 1. Caught of non-equivalent: 31/32 (97%).

| mutant | kind | result |
|---|---|---|
| `snap.loaded` | drop | P3 on fo2-state (2 steps) |
| `snap.cursor` | drop | P6 on fo2-state (10 steps) |
| `snap.send` | drop | P5 on fo2-state (4 steps) |
| `rec.loaded` | drop | P3 on fo2-state (6 steps) |
| `rec.committed` | drop | ERR on fo2-state (3 steps) |
| `rec.send` | drop | P5 on fo2-log (0 steps) |
| `notready.send` | drop | P5 on fo2-state (1 steps) |
| `expire.lost` | drop | P7 on fo2-log (3 steps) |
| `expire.send` | drop | P5 on fo2-log (4 steps) |
| `gotsnap.is` | drop | ERR on fo2-state (3 steps) |
| `gotsnap.clear` | drop | P2 on fo2-state (14 steps) |
| `gotsnap.rows` | drop | P2 on fo2-state (6 steps) |
| `gotsnap.cursor` | drop | P2 on fo2-state (6 steps) |
| `gotrec.is` | drop | ERR on fo2-state (3 steps) |
| `gotrec.apply` | drop | P2 on fo2-state (6 steps) |
| `gotrec.cursor` | drop | P2 on fo2-state (6 steps) |
| `gotrec.credit` | drop | P1 on fo2-log (7 steps) |
| `gotretry.leave` | drop | P5 on fo2-state (1 steps) |
| `gotretry.credit` | drop | P5 on fo2-state (1 steps) |
| `gotexp.is` | drop | P7 on fo2-log (3 steps) |
| `gotexp.dead` | drop | P5 on fo2-log (4 steps) |
| `connect.link` | drop | P5 on fo2-state (0 steps) |
| `bopen.fold` | drop | P5 on fo2-state (1 steps) |
| `resolve.committed` | drop | P4 on fo2-state (5 steps) |
| `resolve.seen` | drop | P4 on fo2-state (5 steps) |
| `resolve.res` | drop | P5 on fo2-state (0 steps) |
| `snap.cursor` | flip | SURVIVED |
| `rec.committed` | flip | ERR on fo2-state (3 steps) |
| `expire.lost` | flip | P7 on fo2-log (3 steps) |
| `resolve.seen` | flip | P5 on fo2-state (6 steps) |
| `gotsnap: clear <-> rows` | swap | P2 on fo2-state (6 steps) |
| `gotsnap: clear <-> cursor` | swap | P2 on fo2-state (6 steps) |
| `gotsnap: rows <-> cursor` | swap | equivalent |
| `gotrec: apply <-> cursor` | swap | equivalent |
| `gotrec: apply <-> credit` | swap | equivalent |
| `gotrec: cursor <-> credit` | swap | equivalent |
| `gotretry: leave <-> credit` | swap | equivalent |

