# E-22, step 1 of 3: the prototype core

**Question (Q-22).** Does the proposed API ([API.md](../../API.md)) cover every pattern on the kernel's five operations, and which patterns need atomicity across partitions or methods at the writer? Step 1 builds the prototype the patterns run on, proves its core under faults, and measures TEST-01. Steps 2 and 3 write every pattern on it ([PROTO.md](PROTO.md) says how).

**Words.** A *partition* is the unit of order (by default one row). A *slot* is one of 1,024 fixed buckets a partition hashes to. A *group* is one ordered log over a set of slots, with one *writer* (its leader) and up to 3 *voters*. The *uncommitted tail* is what the writer appended that a majority has not yet stored; a leader change can lose it. To *fold* is to apply committed records to rows (data does it). An *attempt* is one write with an id its resends keep; *dedup* is the writer answering a resend from its table instead of applying it twice. A *seed* fixes every random choice of a run, so a run can be replayed.

**In short.**
- The core runs: one process, many simulated processes, each resource in 2 groups over 1,024 slots, each group a log whose leader can lose its uncommitted tail. The kernel has exactly five operations, and L2 (dedup, conditions, ops, TTL, `max`, `where`, sessions, claims, fences, the slot move) is a library over them. No sixth operation was needed for what is built so far.
- Under seeded leader changes (204 uncommitted entries lost over 200 seeds), one slot move per seed and 5% message loss, every acknowledged `incr` counted exactly once; a log reader that stops and resumes from cursors got every record once, in order per partition; every replica equalled a fresh fold of the committed log. A seed replays byte for byte. (measured here: [results/checks.txt](results/checks.txt))
- A check-then-set without a condition sold the last item twice in every race, **also when both calls ran on the writer**. The API's op and condition forms held in every seed. So conditions are needed wherever methods run, and placing methods at the writer adds no safety. (measured here: [checks/p14.check.ts](checks/p14.check.ts))
- Building API.md exactly showed eight places it cannot be built as written, or misses its own promise ([API-NOTES.md](API-NOTES.md) Part C). The biggest: five of its one-file examples pass resource keys but no server marker, so they open as clients and never commit (C1); a queue's `extend` and `nack` cannot be built from the verbs (C2); a lock token cannot be "the row's version" (C6); a shape bump breaks "rebuild equals live" unless held rows are upcast (C4).
- TEST-01 holds on the prototype: a fresh node plus a small scenario takes 0.15 ms at the median and 3.9 ms at p99 (bar 5 ms), and 200 chaos seeds take 0.38 s (bar 1 s). The slowest of 2,000 scenarios took 9.6 to 10.8 ms, over the bar; that is about one in 2,000, likely a GC pause. (measured here, under the timing lock, 3 runs: [results/test01.txt](results/test01.txt))

## What was built

TypeScript, run by `node --experimental-strip-types` as fero v4 is; no build step and no dependency but `data`. 3,455 lines of prototype plus 422 of examples and checks, all type-checked by `tsc --strict` (TypeScript 6.0.2), and the examples also type-check against API.md's own `fero.d.ts` with the import pointed at `fero`, so they use the API exactly as typed (measured here: [results/typecheck.txt](results/typecheck.txt)).

| Layer | File | Lines | What |
|---|---|---|---|
| world | [proto/world.ts](proto/world.ts) | 347 | the deterministic executive: simulated processes (AsyncLocalStorage picks which one `fero()` runs in), a virtual clock, one event queue, seeded random streams, a network (seeded latency, FIFO per link, loss) and fsync model, faults (leader change, move, kill, pause, skew, drop), the client history, a trace hash |
| L1 | [proto/kernel.ts](proto/kernel.ts) | 520 | groups over 1,024 fixed slots; the five operations `append`, `read`, `snapshot`, `changeMembers`, `handOver`; replication by events with a majority commit and Raft's current-term rule; elections that keep what the new leader persisted and drop the rest; a heartbeat resend; the controller (grows voters 1 to 3, spreads leaders with `handOver`, makes the slot move, voter leaves) |
| L2 | [proto/l2.ts](proto/l2.ts) | 606 | the writer's state as a fold of its group's log, tail included, rebuilt by a new leader with `read` from its last `snapshot`; the judge in API.md's order (dedup, shape checks, validation, schema, rules, conditions, ops); TTL, `max`, `where`, sessions, claims and leases, fences; the slot move's steps (seal, cut, admit); upcasters |
| L3 | [proto/l3.ts](proto/l3.ts) | 449 | each process's replica, folding committed entries through the seam; one feed that orders entries per group and, across a move, per slot (a new epoch waits for the old group's `out`); log readers with exact cursors; follows; the near cache; the TEST-12 shuffle; the fold monitor |
| L4 | [proto/api.ts](proto/api.ts), [proto/index.ts](proto/index.ts) | 1,007 | `fero()`, roles by declared act, the resource and its verbs, routing (a client through its server: Y `fwd`), retries with one attempt id, read-your-writes, `fresh` reads by read index, read-through, methods and `ctx`, keyed calls in `#calls`, sessions in `#sessions`, `#locks`, the cluster and writes views, `op`, `FeroError`, the statics |
| seam | [proto/seam.ts](proto/seam.ts) | 166 | the one importer of data (DATA-02), shaped like v4's `api/substrate.ts`: the hot-lane fold, the write lens, the snapshot proxy |
| harness | [proto/check.ts](proto/check.ts) | 127 | runs a check per seed with a fault schedule, then the monitors; prints a replay command for a failing seed |

The kernel's surface to the layers above is the five operations, four hooks (`lead`, `depose`, `commit`, `defined`) and each group's read-only status (leader, term, commit index, last index). Every log access above L1 goes through `read`; a new leader's L2 reads its own log end with `read(…, { tail: true })`, which is part of `read` at the leader, not a sixth operation. L2 and the slot move use `append`, `read` and `snapshot`; the controller uses `changeMembers` and `handOver`. Everything else in [proto/kernel.ts](proto/kernel.ts) is the simulation of how those behave, plus the retention policy (when to `snapshot` and compact).

## Method

Each check runs a body per seed in a fresh world, with a seeded fault schedule placed inside the work, then three monitors: no divergence between what a writer judged and what data folded; every caught-up replica equal to a fresh fold of the committed log (through the same seam); no user-code throw while folding. The shuffle (TEST-12) is on in every world. Each check line reports the faults that hit, so a check whose faults land outside the work shows it.

| Check | What it asserts | Seeds |
|---|---|---|
| [core-exactly-once](checks/core-exactly-once.check.ts) | two clients and a server `incr` four counters 60 times under 3 leader changes, a move and 5% message loss: final count = acknowledged incrs; no two acks report the same count | 200 |
| [core-reader](checks/core-reader.check.ts) | a log reader runs live beside a writer, stops at seeded points and resumes from its cursor, across leader changes and a move: per partition, exactly the acknowledged records, once, in order | 100 |
| [core-determinism](checks/core-determinism.check.ts) | TEST-02: each seed run twice gives the same trace hash and the same client history; 30 seeds give 30 traces | 30 × 2 |
| [p01](checks/p01.check.ts) on [examples/p01-live-state.ts](examples/p01-live-state.ts) | P-01 as API.md writes it, three servers and two clients: the seed once, read-your-writes, the server's tap, fold equality | 50 |
| [p14](checks/p14.check.ts) on [examples/p14-invariants.ts](examples/p14-invariants.ts) | P-14 as API.md writes it: two `sell`s of the last item, one winner; two `reprice`s, no lost update; on the writer, on another server, or one of each. Also counts a naive check-then-set | 99 |
| [core-features](checks/core-features.check.ts) | one assertion per behaviour the patterns lean on, no faults: TTL with its reason, `touch`, every condition and op bound, `absent-row`, `cross-partition`, claims (oldest first, live leases skipped, empty claim, ack by token, re-delivery, `touch(…, { lease })`), `expired`, the near cache (`shortfall`, one-hop miss, then followed, `holistic`), follow, presence after a kill, fences across a lock's expiry, the door, a keyed call run once, a live method view, one `load` for many misses, a `none` write, upcasters on held rows, `rows.max`, `lookup`, the gate | 20 |
| [test01.bench](checks/test01.bench.ts) | TEST-01: a fresh solo node; a fresh node plus a scenario; 200 chaos seeds | timing, 3 runs |

Smoke tests not kept as checks also ran: reading shares (every record in exactly one of 4 shares), a keyed call re-run after its server died mid-call (same attempt ids, `ctx.now()` and `ctx.id()`; the row written once), a write during a slow `load` winning, and a client that starts before any server (its write waits, `unplaced`, then commits).

## Results

Checks, measured here ([results/checks.txt](results/checks.txt); Node 22.22.0, data 63fea66, run under the heavy lock at load 1.9; times are not timing results):

| Check | Result | Faults that hit (summed over seeds) |
|---|---|---|
| core-exactly-once | ok, 200 seeds, 1.8 s | 400 elections, 204 uncommitted entries lost, 200/200 moves done, 86 resends answered by dedup (1 found its attempt still in a new leader's uncommitted tail) |
| core-reader | ok, 100 seeds, 1.3 s | 200 elections, 25 entries lost, 100/100 moves, 6 dedup |
| core-determinism | ok: 30 of 30 seeds identical twice; 30 distinct traces | 2 leader changes and a move per seed |
| core-features | ok, 20 seeds, 0.9 s | none (by design) |
| p01-live-state | ok, 50 seeds, 0.3 s | 100 elections, 58 lost, 50/50 moves, 12 dedup |
| p14-invariants | ok, 99 seeds, 0.5 s | 99 elections, 16 lost, 99/99 moves, 4 dedup |
| naive check-then-set (counted) | both callers sold the last item in 33 of 33 races (writer + writer), 33 of 33 (writer + other), 33 of 33 (other + other) | |

TEST-01, measured here under the timing lock ([results/test01.txt](results/test01.txt)):

| Measure (TEST-01) | Bar | Run 1 | Run 2 | Run 3 | Median of runs |
|---|---|---|---|---|---|
| a fresh solo node: `fero.world()`, `fero(name, { listen: false })`, close. p50 / p99 / max of 2,000 | none | 0.061 / 0.73 / 8.4 ms | 0.065 / 0.51 / 5.6 ms | 0.047 / 0.52 / 5.5 ms | p50 0.061 ms, p99 0.52 ms |
| a fresh node plus a scenario: a seed row, an `incr` with a bound, a `set`, a sync read, close. p50 / p99 / max of 2,000 | ≤ 5 ms | 0.147 / 3.94 / 9.6 ms | 0.140 / 3.95 / 10.8 ms | 0.147 / 3.16 / 10.3 ms | p50 0.147 ms (0.140 to 0.147), p99 3.94 ms (3.16 to 3.95) |
| 200 chaos seeds: three servers and a client, 10 writes, a leader change and a slot move, then the monitors | ≤ 1 s | 397 ms | 380 ms | 367 ms | 380 ms (367 to 397); 274,339 events, 1.4 µs per event |
| load average at start | | 2.53 | 1.36 | 1.86 | |

Each run held the box alone (`$SP/bin/timing`), after 200 warm-up iterations. The scenario is this prototype's, not fero test's café (TEST-01's own acceptance test), which does not exist for v5 yet. The p99 sits under the bar; the max (about 1 in 2,000) does not, and a 10 ms stall in a test runner would show as a slow test, not a wrong one.

Bugs the checks found in the prototype while it was built (each fixed, each now covered): a dropped replicate message stalled a follower forever, and a lost ack stalled a commit (fixed with a heartbeat resend); elections kept only what the old leader knew followers held (now what they persisted, as Raft); the fold monitor counted a replica as caught up while the shuffle still held entries back; a keyed call's `ctx.now()` changed on a re-run; a `durability: 'none'` write committed before its writer listened for the commit, so it answered only on the client's resend (159 ms of virtual time, now 1 ms); read-through ran only on a process that did not hold the row, and once per server rather than once per key (now the miss goes to the writer).

## What this cannot show

- **It is a simulation, not fero.** No disk (an fsync is a seeded delay), no sockets, no real clocks, one OS process. Raft is modelled at the level of "what each voter persisted and acked", without joint consensus (E-14 owns that) or PreVote (E-38).
- **TEST-01's numbers are the prototype's,** not a v5 kernel's: they say the world, the stack and data's fold can be made and run a scenario fast enough in TypeScript; a real kernel adds journal and socket set-up that a solo, socketless node may skip.
- **Patterns.** Two of 22 patterns run as examples (P-01, P-14), and two core checks cover P-11's and P-07's promises. The L5 libraries, the other patterns, Porcupine and Elle (TEST-13) and the 100-seed shuffle across every example are steps 2 and 3.
- **Not built:** fork, erase, tokens and claims, the config cascade, disks, `credit`, `gaps` (API-NOTES Part A).

## API changes this step shows

From [API-NOTES.md](API-NOTES.md) Part C:
1. A resource key (`rows`, `history`, `partition`, `durability`, `copies`, `shape`) is a server marker; else P-02, P-06, P-07, P-13 and P-16 never commit as written (C1).
2. `touch(key, { lease, if })`, so a claim's lease can be extended or ended: `Msg.extend` and `nack({ delay })` need it (C2).
3. A `FeroError` that escapes a handler answers with its own code, not `threw` (C3).
4. P-20: held rows pass the upcasters at a shape bump, or "rebuild equals live" fails (C4).
5. Drop Q-A8's `at: 'writer'` as a safety option: a check-then-set needs a condition or an op wherever it runs (C5).
6. P-10: a lock's token is the version of the acquiring write; `absent` and `expired` re-create a row (C6).
7. TEST-12: the log-mode shuffle is per slot, so a cursor stays one position per slot (C7).
8. `LiveCall.open()` returns a handle with `ready` (C8).

## Run it

`./run.sh` (the type check, the checks, then the timing bench under the lock), `./run.sh types`, `./run.sh checks`, `./run.sh timing`, or one check: `node --experimental-strip-types --no-warnings checks/core-reader.check.ts --seeds 100`. `DATA` names data's folder; [fetch.sh](fetch.sh) fetches data at 63fea66 on a fresh machine. Nothing is downloaded.

Q-22 (step 1 of 3): the five kernel operations carry L2 (dedup, conditions, ops, TTL, sessions, claims, fences) and a slot move with no sixth operation so far, and exactly-once, per-partition order and fold equality hold over 100 to 200 seeds of tail-losing leader changes and moves; a check-then-set is unsafe without a condition even at the writer; TEST-01 holds in the prototype (a fresh node plus a scenario 0.15 ms median and 3.9 ms p99 against 5 ms; 200 chaos seeds 0.38 s against 1 s). Moves: MIN and its K `lib` family up on P-07, P-11, P-14, DATA-01, TEST-02 and TEST-01; U `ldr` down on P-14 (no safety gain); API.md changes C1 to C8 before phase 1.
