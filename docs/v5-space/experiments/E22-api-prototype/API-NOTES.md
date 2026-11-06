# E-22 step 1: where the prototype differs from API.md, and why

The prototype implements [API.md](../../API.md) draft 1 as written wherever it can. This file lists every place it could not, or chose not to, with the reason. Part A is scope (step 1 is the core). Part B is what one simulated process forces. Part C is the part that matters: places where API.md, as written, cannot be built or does not keep its own promise. Part C is what goes back into API.md.

Evidence labels: **measured here** (with the check that shows it), **reasoned**.

## A. Not built in step 1 (scope)

| What | Status | Who builds it |
|---|---|---|
| The L5 libraries: `queue`, `lock`, `group`, `derive`, `saga`, `limiter`, `service`, `migrate`, `tape`, `gateway` | not built. The core gives them what they need (Part C3 to C7, and [PROTO.md](PROTO.md) "What the core offers a library") | steps 2 and 3 |
| `fero.fork`, `erase` | throw `config` ("not built") | steps 2 and 3 if TEST-06 is in scope |
| tokens and claims (`token`, `rules.read`, `revoke`, `forbidden`) | `fero.token` returns an unsigned token; nothing checks claims | later; no pattern check needs it yet |
| the config cascade (flags, `FERO_*`, `fero.opt.*`), `bind`, TEST-04 (`unbound`) | not built: options come from the call only | later |
| disks: `dir`, `object`, the WAL | not built. `persisted` means "a majority finished a simulated fsync" (a seeded delay) | — |
| `read({ credit })`, `LogReader.gaps` for `durability: 'none'`, `journal`, `diag`, `memory` | accepted, not acted on | later |
| `cluster.numbers.writesPerSec`, `clients` | always 0 | later |
| a keyed call re-run by fero itself when its server dies | the caller calls again with the same key; the new server takes the lapsed claim and re-runs with the same attempt ids, `ctx.now()` and `ctx.id()`, so its writes are answered by dedup (smoke test, not a check yet). `ctx.now()` is the claiming server's clock, kept in the `#calls` row, not the claim's writer time | step 2 (TEST-03) |
| an unkeyed call's background resend | not built: an unkeyed call is never resent (as API.md says) | — |

## B. What one simulated process changes

- **B1. Processes.** A pattern written as two files in API.md is two simulated processes here. `world.proc(id)` makes one; `proc.run(fn)` runs `fn` as that process, so `fero()` and any library inside it resolve there (AsyncLocalStorage). `proc.fero(name, opts)` is the short form. Outside any `run`, `fero()` resolves in the process `main`.
- **B2. The World.** API.md's `World` is `{ seed, now(), id(), advance(by), close() }`; the prototype's has all of these, plus `proc`, `settle`, `chaos`, `faults`, `kill`, `pause`, `history`, the field `time` (virtual ms) and the trace hash. `fero.world()` also takes `groups` (groups per resource, default 2), `net`, `fsync`, `keys` and `trace`.
- **B3. `fero.spawn`** throws: it has no meaning inside one OS process.
- **B4. The catalog** (`#meta`) is one kernel table, not a replicated group: the prototype has one controller (C `cent-co`). It grows voters, spreads leaders with `handOver`, and makes the one slot move.
- **B5. Membership** changes one voter per `changeMembers`, applied at once. Joint consensus is not modelled (E-14 owns it).
- **B6. A client's first picture** arrives with no latency: its replica reads the committed log directly when it opens. API.md says reads before the first picture throw `shortfall`; that path is not exercised.
- **B7. The door** (`methods-only`) is checked by the process that issues the write. A real server must check it when the write arrives.
- **B8. The I-29 collector** (releasing views a handler made) is not ported: `ctx.data` is the server's lens.
- **B9. `history: 0`** keeps the whole log (no compaction), because "what recovery needs" depends on snapshots the prototype does not schedule. A number of records or a time compacts with the `snapshot` operation, and an old cursor then gets `expired` with `earliest` (checked in `checks/core-features.check.ts`).
- **B10. System resources** `#locks`, `#sessions` and `#calls` are ordinary resources with fixed names; the first `fero('#…')` creates one. API.md names them ("every writer follows `#locks`", `#sessions`, `#calls`) without saying how a library opens them; the prototype's answer is `fero('#locks')`.
- **B11. "Writers follow `#locks` and `#sessions`"** is modelled as the writer's process folding those resources: a fence is judged against the `#locks` row as the writer's own process holds it, and a lapsed session reaches every writer one event later.

## C. Where API.md cannot be built as written, or misses its own promise

Each item has a proposed change. The short list is in the README's "API changes".

**C1. A resource key does not make a server, so five one-file patterns never commit.** (measured here: the first run of the feature tests hung with `no-writer`; `cluster.health` says `unplaced`)
- API.md §4 counts as server markers `server`, `listen`, `dir`, `seeds`, `data`, `methods` and the code keys. `rows`, `history`, `durability`, `partition`, `copies` and `shape` are not markers.
- So P-02 (`fero('cache', { rows: { ttl, max } })`), P-06, P-07, P-13 and P-16 open their resource as a client. Only a server creates a resource, so their writes wait as `pending` forever unless another process defines the name. Each looks like it defines the resource, and none does.
- Proposed: a resource key is a server marker (only the creator writes the catalog). No pattern's client passes one (P-03, P-05 and P-19 clients pass only `cache`, `hosts` and `token`), so nothing else changes. The other choice is to add `server: true` to those five examples.
- Related, and not a defect: P-08, P-10, P-11, P-15 and P-17 open bare names (`fero('orders')`), which are clients by design; they assume a server that the example does not show. Their checks must start one.

**C2. A claim's lease cannot be extended or ended by any verb, so `Msg.extend` and `nack({ delay })` cannot be built from L4.** (reasoned, while building `claim`)
- `claim` sets a lease the writer keeps beside the row. `set` and `remove` must not touch it (else `ack` and progress writes would end it by accident), and no other verb reaches it.
- The prototype adds two options to `touch`: `touch(key, { lease, if })`. `lease` sets the lease to that long from now (`0` ends it), and `if` makes it conditional (`{ version: token }`). So `extend` is `touch(key, { lease, if: { version: token } })` and `nack({ delay })` is `touch(key, { lease: delay, if: { version: token } })`: the message is held by nobody until then.
- Proposed: add `lease?: Duration` and `if?: Cond` to `touch`'s options in API.md.

**C3. A conflict inside a method reaches the caller as `threw`, not `conflict`.** (measured here: `checks/p14.check.ts`, the losing `sell` rejects with code `threw`, reason "conflict ... below min 0")
- API.md §4: "One that throws answers `threw` with its message". P-14's `sell` lets the `conflict` from `op.incr(-1, { min: 0 })` escape, so its caller cannot tell "sold out" from a bug.
- Proposed: a handler that lets a `FeroError` escape answers with that error's `code` and `outcome`; `threw` is kept for the app's own errors.

**C4. After a shape bump, the live state is not what a rebuild gives, unless held rows are upcast too.** (measured here: the fold monitor reported `u1` as `{ name: 'Ada Lovelace' }` live and `{ name: { first: 'Ada Lovelace', last: '' } }` rebuilt, until the fix below)
- API.md P-20: records written under an older version pass the upcasters "on every path (folds, follows, replays)". A record folded before the bump is already in every replica's rows in the old shape, and nothing upcasts it. A rebuild from `history: 'all'` upcasts it. So P-16's "a rebuilt projection equals the live one" fails right after any bump, until `migrate` has rewritten every row.
- The prototype's `fero.alter(name, { shape })` passes every row each fold holds (every replica, every writer) through the upcasters as a whole-row update, at the bump. The writer's state upcasts entries by their stamped version too, so a new leader judges conditions on the new shape.
- Proposed: P-20 says this, and prices it: one pass over the held rows per process per bump.

**C5. A check-then-set is unsafe even when both calls run on the writer, so methods at the writer (U `ldr`, Q-A8's `at: 'writer'`) buy no safety.** (measured here: `checks/p14.check.ts`, 99 seeds)
- A naive method (read the row, then a plain `set`) sold the last item twice in 33 of 33 races with both calls on the writer, 33 of 33 with one on the writer, and 33 of 33 with both elsewhere.
- The API's own forms held in every seed, wherever they ran: `sell` (an op) had exactly one winner, and `reprice` (`if: { version }`) never lost an update.
- Why the writer does not help: a handler reads its server's committed fold, and two handlers interleave at their awaits. Only a writer that runs one handler at a time per partition, against its log-end state (an actor), would make the naive form safe. That is a new mechanism, and it would hold a partition's writer for the length of user code.
- Proposed: keep U `any` and the rule "a check-then-set carries a condition or is an op" (API.md §4). Drop Q-A8's `at: 'writer'` option, or state that it is a latency choice, never a safety one.

**C6. A lock's token cannot be "the row's version", because a renewal changes the version.** (reasoned while building fences; the fence path is in the smoke tests)
- API.md P-10 says the token is a `Version` that strictly rises across holders, and every writer follows `#locks`. If the token were the lock row's latest version, the holder's own renewal would make its token look old, and its next fenced write would be refused `fenced`.
- The prototype's rule: the token is the row's **born** version, the version of the write that created it. A write whose condition `absent` or `expired` passes re-creates the row (its born version, ttl, lease and session start afresh), because an expired row is absent in meaning. Writers compare a fence against the newest born version of the `#locks` row they have seen, and against the fences in their own log.
- Proposed: API.md P-10 states it this way: token = the version of the acquiring write; renewals keep it; `absent` and `expired` re-create a row.

**C7. The log reader's shuffle must keep order within a slot, or the cursor grows with partitions.** (reasoned while building cursors; `checks/core-reader.check.ts` checks the result)
- A cursor that holds one position per group (or per slot, API.md's "about 8 KB for 1,024 slots") is exact only if delivery inside a group (or slot) keeps log order. TEST-12's shuffle, read strictly, interleaves "records of different partitions", which includes two partitions in one slot.
- The prototype shuffles the state-mode fold per partition (seeded delays that keep each partition's order), and shuffles log-mode reads across groups only.
- Proposed: TEST-12 says the log-mode shuffle is per slot. A per-partition shuffle in log mode would need per-partition positions in the cursor.

**C8. `LiveCall.open()` cannot know the view's shape before the server answers.** (measured here: an object-born mirror of a `za` view folded to `{"0":{"left":50}}`)
- An ordered view (`za`, `top`, `az`) needs an array-born mirror; a keyed view needs an object-born one. `open()` is synchronous, before any answer.
- The prototype returns a handle whose `tap`s are kept and replayed onto the mirror made at the first answer; `snapshot()` is `undefined` until then, and other operators throw `shortfall`.
- Proposed: `open()` returns a handle with `ready`, like `Follow`.

**C9. `console.log(f.snapshot)` prints `{}` if the snapshot is a Proxy.** (measured here) P-01's server logs it. The prototype gives the proxy a Node inspect hook; a real build needs the same (or a plain frozen object, at a cost per commit).

**C10. A live `for await (… of f.read(…))` never ends.** In a test world with nothing else pending, Node exits with code 13 (an unsettled top-level await). P-06, P-07 and P-16 iterate forever as written. Proposed: fero test reports "a reader waits and nothing can wake it" instead of the exit; examples break out or `close()`.

**C11. Smaller points** (reasoned; each is a one-line decision for API.md)
- `touch` is a write: it gives the row a new version, so an `if: { version }` taken before a touch then fails `conflict`.
- `Claimed.token` is the version of the claim's entry, the same for every row one `claim` hands out. `ack` as `remove(key, { if: { version: token } })` works with it.
- `Ack.value` is present only for ops (the new value at the key); a `batch` gives each ack its own.
- `while: 'session'` inside a method binds the caller's session (API.md), but the caller's process must keep that session's lease. The prototype starts a process's session keeper on its first session-bound write of its own; a method's write on behalf of a caller does not start the caller's keeper.
- A near-cache miss (`get` of a row this process does not hold) is answered from a server's fold, which may trail a write another process already got acknowledged: the reader's floor covers only what it saw or wrote itself (API.md §4, "Reads"). So right after another process's ack, a miss can answer `undefined` for a row that exists. That is the promise as written; P-03's text "a miss is one hop" should say it, and `get(key, { fresh: true })` is the linearizable form (measured here: `checks/core-features.check.ts` failed 2 of 5 seeds this way before it settled first).
- `validation` runs where a write enters if that process is a server, and again at the writer (API.md says both); a client has no code to run it.

# E-22 step 2: what writing every pattern showed

Step 2 wrote every pattern of DESIGN-V5 §5.1 plus P-19 to P-22 as an example of at most 40 lines, built the L5 libraries, and checked each guarantee under faults ([patterns/README.md](patterns/README.md)). Part D is what the API, as API.md writes it, got wrong, left out, or made awkward. Part E is the bugs those checks found in the step-1 core, each fixed and named. Labels as above: **measured here** (with the check), **reasoned**.

## D. API.md: missing, wrong, or awkward

Each item ends with a proposed change. The README's "API changes" lists them in short.

**D1. A library needs a timer, and under a world there is none.** (measured here: every library check)
- A lock renews, a waiting take gives up, a consumer group rebalances, a paced job sleeps, an ask times out. All need a timer. API.md's `World.advance` says "timers, leases and TTLs fire in order", but the API has no timer, and a real `setTimeout` breaks replay (PROTO.md rule 4).
- Built here: [patterns/timers.ts](patterns/timers.ts) fakes `setTimeout`/`setInterval` while a world is bound, as Node's own `node:test` mock timers do. A ref'd timer keeps the world running (as it keeps Node alive); an unref'd one (a renewal loop) does not; a dead process's timers never fire; a paused one's fire late. The libraries use plain `setTimeout`, as they would live.
- Proposed: TEST-02 and API.md's `World` say that under a world `setTimeout`, `setInterval` and their `clear`/`ref`/`unref` run on the world's clock. No new verb.

**D2. A library cannot create its own resource from a client.** (reasoned from C1, which step 1 measured: a resource nobody serves never commits; the checks here have every server call the library first)
- `queue('thumbs')` in a worker opens `thumbs` with `partition: { before: '/' }`. The worker is a client, and only a server creates a resource (Q-A1, C1), so every add waits as `pending`. System names (`#…`) are created on first open, but take no options (an open with `partition` is refused `config-differs`).
- In the checks, each server calls the library once first. That leaks the library's layout into the app.
- Proposed: a client may create a resource whose keys are all declarative (`partition`, `rows` without `where`, `history`, `durability`, `copies`); only code keys (`methods`, `validation`, `schema`, `rules`, `load`, `rows.where`, `shape.up`) need a server. This replaces C1's "a resource key is a server marker", which would make every queue worker a server.

**D3. Effectively once needs a caller-chosen attempt id on writes, and L4 has none.** (measured here: [checks/p17.check.ts](patterns/checks/p17.check.ts), 40 seeds)
- API.md promises that `group.run`'s and `derive`'s outputs "carry attempt ids made from the source position", and P-15's saga and P-20's migrate need the same for their steps. Attempt ids are internal (API.md §8). Only a keyed method call's `ctx` sets them, and a library cannot make a consumer host a method without making it a server.
- The same derive, built with plain verbs: totals wrong in 10 of 40 runs (22 cents counted twice in all). With ids: exact in 40 of 40.
- Built here outside the core: [patterns/lib/ids.ts](patterns/lib/ids.ts) gives a handle whose writes take their attempt ids from the library, as a keyed call's ctx does.
- Proposed: `WriteOpts.id?: string` (and on `BatchWrite`): an idempotency key. A resend or a re-run with the same id within the dedup horizon is answered from the first. The kernel's five operations are unchanged; this is L4 exposing what L2 already does.

**D4. The dedup check covers the write's condition, so a later holder's re-send is refused `call-diverged`.** (measured here: [checks/p15.check.ts](patterns/checks/p15.check.ts): money not conserved in 6 of 40 runs until the saga handled it)
- A saga's step carries the attempt id `saga:<id>:<i>` and `if: { fence }`. A recoverer re-sends step i under its own, newer token. The writer finds the attempt but a different body (the token differs) and refuses `call-diverged`. The first saga library treated that as a failed step and undid half a unit.
- The same happens to a keyed call whose re-run reads a version its first run changed: its `if: { version }` differs.
- Fixed in the library: `call-diverged` means "this attempt already committed", so the step counts as done (as migrate does).
- Proposed: the dedup hash covers the change (key, value or op, remove), not its `if`; a resend is the same change whatever condition it carries. API.md §5 then says `call-diverged` is a different change under one id.

**D5. `delay` cannot be measured from writer time with one write.** (reasoned; measured here: P-22's delayed message is never claimed before its `at` by writer time, 40 of 40)
- The queue stores `at` in the row, and `claim`'s `where(row, t)` compares it with writer time. `at: Time` is exact. But `delay` needs "writer time of the add, plus delay", and a client cannot read writer time before it writes, and `where` does not get the row's write time. So `delay` is measured from the adder's clock: early by up to the adder's skew, which `skew.max` does not bound (it bounds writers).
- Proposed: `where(row, t, info: { written: Time })`, or an op that stamps writer time (`op.now(offset)`). Either makes `delay` exact with one write.

**D6. A waiting `take` is woken by an enqueue, not by a lapsed lease.** (measured here: P-22, woken at most 3.5 ms of virtual time after an enqueue's ack; reasoned for lapses)
- A lease lapse writes no record, so nothing wakes a waiting take when another worker's lease runs out. The library polls once a second. P-22's "woken within C + one hop" holds for enqueues only.
- Proposed: say so in P-22, or let `claim` answer with the earliest lease end so a waiter can sleep until then.

**D7. The service cannot be `durability: 'none'`.** (reasoned; measured here: P-21's costs)
- API.md defaults `service` to `'none'` (Q-A17) and builds it "on claim, sessions and conditions". `'none'` needs `rows: false`, and `claim` needs rows (`no-rows`). The two cannot both hold. The service here is `persisted`.
- An ask is three commits (the request, the answerer's claim, the reply). In a calm run: median 6.0 ms of virtual time against 2.15 ms for one write from the same asker. With one answerer killed mid-request in half the runs: 383 answers and 17 timeouts out of 400 asks, never two answers to one request.
- Proposed: either a `none` rung that keeps rows in memory (decision 4b's memory rung), or P-21's bar is three commits. `no-answerer` "at once" reads local presence, so a just-dead answerer's presence lingers for `session.ms` and asks time out instead.

**D8. Pattern code that does not run as API.md writes it.** (measured here)
- P-02 touches `sid-9f2`, which nobody wrote: `touch` answers `absent-row`. The example writes it first.
- P-05's `live.tap` gives deltas only: a socket that joins sees nothing said before it. The example sends `live.snapshot()` once `ready`, then the deltas.
- P-20 opens `users` at `shape.version: 3`. On a resource that exists, an open with a new `shape` is refused `config-differs`, so a three-version history is two `fero.alter` steps (here [p20-shape.ts](patterns/p20-shape.ts)). The prototype's `fero.alter` also ignores code keys (`schema`): the v3 code opens with `schema` instead.
- P-07 keeps a cursor as text: API.md's branded `Cursor` needs a cast when it comes back from storage.
- P-06, P-07, P-16 loop over `read()` forever (C10): the examples stop after n, or `close()`.

**D9. Expiry and presence are late by one election when the writer fails over.** (measured here: P-02, P-13)
- P-02's "within one tick + skew.max" holds while a writer exists: 0 ms late in 30 calm runs. With a leader change near the ttl: up to 2,036 ms late (30 runs). No row ever went early.
- P-13: a killed client's rows went within 9.8 s of the kill (`session.ms` 10 s) with no failover; up to 12.4 s with a `#sessions` failover near the lapse.
- Proposed: P-02 and P-13 state "plus any time without a writer, at most `election.ms` + jitter".

**D10. A lease must survive its own group's election.** (measured here: P-13 seed 27 before the fix in E10)
- A client paused 5 s (under the 10 s lease) renewed into a `#sessions` election (2.3 s with no writer); with retry backoff its renewal landed after its lease, and the new writer lapsed a live session. P-13 forbids that.
- Fixed (E10) as etcd's lessor does on promotion: a new writer of `#sessions` or `#locks` gives every lease at least one `election.ms` to be renewed.
- Proposed: API.md says leases are judged by writer time while a writer exists, and a new writer extends every lease by one election.

**D11. Fences must remember tokens after the lock row goes.** (measured here: P-10, a stale token on a row the newer holder never wrote: committed in 2 of 3 runs before the fix in E6, fenced in 40 of 40 after)
- API.md P-10: "every writer follows #locks, so this holds across groups". The prototype's writers compared a fence with the live `#locks` row; once the newer holder released (or its lease expired), the row was gone and so was its token.
- Proposed: P-10 says each writer keeps the newest token it has seen per lock (a map bounded by the number of locks), or a released lock leaves a tombstone with its last token.

**D12. A live view's stream is not the log's record stream.** (measured here: P-12, the screen's top-10 drifted out of order in 60 of 60 runs before the fix in E7)
- `Rec` excludes data's `move` records (DATA-03: the log has no order moves). But an ordered view (`za`, `az`, `top`) folded through data's lane emits `move` records, and a mirror without them loses its order (shown directly against data: 10 moves in 72 changes, mirror wrong without them, exact with them).
- Proposed: DATA-03 and `LiveCall` say a view stream carries data's full `ChangeRecordV2`, moves included; only the log's records exclude them.

**D13. `rows.max` per group rounds up.** (measured here: P-02, `max: 8` over 2 groups held 9 rows in 17 of 60 runs)
- Proposed: API.md says the whole resource holds at most `max + groups − 1` rows, or each group rounds down.

**D14. A tape needs one partition.** (measured here: P-18, a tape keyed one row per match replayed out of order under the shuffle)
- TEST-05's "replay reads them in order" needs an order across recordings; fero orders only within a partition. The tape here keeps all its recordings in one partition, so one tape has one writer.
- Proposed: TEST-05 says so; a tape that must scale writes uses several and replays by recorded time.

**D15. Check-then-set: placing methods at the writer is not a safety mechanism.** (measured here: [checks/cts.check.ts](patterns/checks/cts.check.ts), 120 seeds, calls from clients)
- Two clients call one method at once; each call runs on the server its client reached: both on the writer of the row's group, one there, or neither. In half the seeds a leader change lands inside the race. Both callers sold the last item:
  - a plain read, then a plain set: 120 of 120 races, wherever the calls ran;
  - a `fresh` (linearizable) read, then a plain set: 120 of 120; a fresh read does not help, the gap is between the read and the write;
  - API.md's forms, `if: { version }` and `op.incr(-1, { min: 0 })`: 0 of 120 each;
  - plain read and set, but run on the writer one call at a time per row (Q-A8's `at: 'writer'`, built in the check): 0 of 120 while both calls reach the same server; with 3 s of work in the handler and a failover between the two calls, so the second reaches the new writer: 120 of 120.
- So C5 stands, from clients too: conditions and ops are the safety; `at: 'writer'` is a latency choice at best.

**D16. Smaller points.** (reasoned, while building the libraries)
- A consumer group's share count is not in the API (the library uses 16); `Group.generation: number` has no natural meaning when each share has its own token (here: shares taken so far).
- Nothing finds an abandoned saga: recovery happens when some process calls `saga` with the same id. A sweeper (or a library call `saga.recover()`) is needed; API.md should say who runs it.
- A saga stores its steps, so an `Op` needs a stored form; API.md's `Op` is opaque. The prototype's op is a plain object, so it worked here.
- A saga id runs once: the outcome is kept a day, as a call key's is. API.md should say so.
- `ClusterView.tap` has no way to stop; the libraries watch with `follow(...)` and `close()` instead.
- `group({ from: 'latest' })` means "latest when this share is first taken", which differs per share.
- `none` pub/sub lost nothing in the simulation (30 runs, 900 deliveries), because followers there take an entry within 0.4 ms. `LogReader.gaps` is not built, so its count is untested.

## E. Bugs the pattern checks found in the step-1 core, each fixed

"Do not change the core except to fix a bug." Each fix below is a few lines, names its check, and is marked `bug fix, E-22 step 2` in the code. Step 1's own checks pass after all of them (results in [patterns/results/checks.txt](patterns/results/checks.txt)); their fault counts moved a little (core-exactly-once: 220 tail entries lost and 79 dedup answers, against 204 and 86 in step 1's file), because E1 and E8 change the order of events.

| # | Where | The bug | Found by |
|---|---|---|---|
| E1 | [proto/world.ts](proto/world.ts) `#drive` | an event's callback (a tap, a timer) ran as whichever process had started the driver, so `fero()`, `fero.now()` and timers inside it resolved in the wrong process; now each event runs as its own process | a probe: an event for `s1` ran as `main` |
| E2 | [proto/world.ts](proto/world.ts) `deferred` | a promise made on a dead process counted as pending forever, so the world never stopped; now it never settles and never holds the world, as `kill()` does for the ones it had | P-08 (stopping a dead member's runner) |
| E3 | [proto/l2.ts](proto/l2.ts) `#armTtl` | with the writer's clock behind world time (inside `skew.max`), the ttl timer re-armed at the same instant forever; now it waits out the lag | P-02 seed 4 |
| E4 | [proto/l2.ts](proto/l2.ts) mover `admit` | rows arriving by a slot move kept their ttl but no timer until their group's next write, so a moved row with no later write never expired | P-02 seeds 5, 6, 8 |
| E5 | [proto/l3.ts](proto/l3.ts) reader | the `earliest` cursor an `expired` refusal gives moved only the group that tripped; another compacted group made reading on throw `expired` again | P-07 (31 of 60 seeds) |
| E6 | [proto/l3.ts](proto/l3.ts), [proto/api.ts](proto/api.ts) fences | a released or expired lock row took its token with it (D11) | P-10 |
| E7 | [proto/seam.ts](proto/seam.ts) `ingest` | a live view's stream dropped data's `move` records (D12) | P-12 |
| E8 | [proto/l3.ts](proto/l3.ts) commit notices | a dropped commit notice was never sent again, so a client's read-your-writes wait on a quiet group never ended | P-11 seeds 8, 58 (5% message loss) |
| E9 | [proto/l3.ts](proto/l3.ts), [proto/api.ts](proto/api.ts) `follow` | `follow({ prefix })` or `{ share }` on a near cache held nothing and dropped every delta; now it asks a server for every matching partition, holds them pinned, and holds new ones as they appear | P-19 (40 of 40 seeds) |
| E10 | [proto/l2.ts](proto/l2.ts) `#lead` | a new writer lapsed live leases whose renewals could not reach any writer during its election (D10) | P-13 seed 27 |

# E-22 step 3: what faults, the shuffle and the outside checkers showed

Step 3 ran every check under three modes (calm; the check's faults plus a forced leader change and slot move aimed at a write in flight; the same with TEST-12's shuffle), 100 seeds each, recorded every client history, and checked the histories with Porcupine (linearizability per partition), Elle's list-append checker (Go port) and seven direct checks ([verify/](verify), [README.md](README.md)). Part F is what that found about the API and its layers. Part G is the bugs it found in the prototype, each fixed and named. Labels as above.

## F. API.md: wrong or missing, found under faults

**F1. A refusal answered from the writer's log end can be a refusal by a write that never happens.** (measured here: Porcupine, `lin-kv` calm seed 77; [verify/phantom.check.ts](verify/phantom.check.ts): 10 of 100 seeds before the fix, 0 after)
- API.md P-14: conditions and ops "are judged at the one writer, against its log-end state, so they are linearizable per partition". An `ok` waits for its own commit, so it is. A refusal (`conflict`, a bound, `absent-row`) was sent at once, from a state that may hold uncommitted entries.
- Seen two ways: a `conflict` caused by an incr still in the tail, then a fresh read that started after the refusal saw the old version (Porcupine: not linearizable); and, with the incr's client killed and a leader change, the incr was lost and the refusal was caused by a write that never committed (a *phantom conflict*).
- Proposed: P-14 and L2 say "a refusal, an empty `claim`, and a `call-diverged` answer are sent once everything the writer had appended when it judged has committed; a writer deposed first sends nothing, and the resend is judged again". Cost: a refusal waits up to one commit when the writer has an uncommitted tail (none when it has not). No new operation: it is the commit wait an `ok` already does.

**F2. A row bound to a session outlives the session forever if the process dies before its session record commits.** (measured here: P-13, 19 of 100 seeds with faults and 12 of 100 with the shuffle before the fix; 0 of 100 after)
- The session keeper's first record and the first bound write go out together. With `#sessions` electing a leader during the first record, the record never commits; the process is killed; the bound row did commit. No writer knows that session, so it never lapses, and the row is never removed. P-13 says a lapsed session's rows go "within `session.ms` plus one tick".
- Proposed: API.md says a `while: 'session'` write is sent only after the session's record has committed (built here in L4), or the writer refuses a write bound to a session it does not know, as etcd refuses a put that names an unknown lease.

**F3. Sagas as API.md describes them allow write cycles between units (G0) when a holder dies or pauses mid-saga.** (measured here: Elle on [verify/elle-saga.check.ts](verify/elle-saga.check.ts): G0 in 16, 19 and 10 of 100 histories (calm, faults, shuffle) with step 2's saga; 0 of 300 with the two rules below)
- REQUIREMENTS P-15's MUST is checked as "no G0 (no write cycle between units)". A dead holder's partition locks lapse with its lease; another unit takes them and writes the same rows; a recoverer finishes the first unit later. Unit A is before B on one row and after B on another. Each unit is still all applied (step 2's direct check passed); the order between units is not.
- A second way in: each step was fenced by the saga's own lock, not by its partition's lock, so a paused holder whose partition lock lapsed kept writing there.
- Proposed (both are L5 rules; no kernel change): (1) each step carries the fence of its partition's lock, and a saga marks its intent `locked` once it holds all its partition locks, before its first step; (2) a saga that finds another saga's unfinished, `locked` intent touching its partitions resolves that saga (finishes or undoes it, waiting for its lock to lapse if its holder is paused) before writing. This is Percolator's rule: a lock left by a dead client is resolved before it is taken over. API.md P-15 should say "locks belong to the unit until it finishes or is undone, not to the holder's lease".

**F4. A saga cannot undo an op that has no inverse.** (measured here: the `undo` variant of the Elle workload: every history lost list elements (incompatible order in 87, 79 and 86 of 100; the direct check of P-15's MUST failed in every seed))
- `Step.value` may be any op. The saga undoes `incr` by its inverse and a plain set or remove by the value it replaced; any other op (`push`, `merge`, `max`, `min`) is undone by removing the key, which deletes what other units wrote there.
- Proposed: `Step` gains `undo?: Op | { value } | { remove: true }`, and `saga` refuses at the start a step whose op it cannot invert and that has no `undo`.

**F5. P-10's lock holds what fencing promises, and a little less than its check assumed.** (measured here: P-10, 1 of 100 seeds with faults and 2 of 100 with the shuffle, after the fixes in G)
- Seed 33: D10's rule (a new writer of `#locks` gives every lease one `election.ms`) applied at each election. Two `#locks` elections inside one 15 s pause extended a 10 s lease past the pause, so the paused holder was still the holder when it woke and the other never got the lock. One holder at a time; liveness, not safety.
- Seed 68 (shuffle): the other process did take the lock (a newer token), and the paused holder's write under the old token still committed, because the ledger's writer had not yet folded the new `#locks` row (writers follow `#locks` asynchronously; the shuffle widens that lag by up to 2 ms). Its write landed before the new holder's first protected write, so in the ledger's log tokens never went back: TEST-13's fencing checker (per log) and the real-time check of fenced writes were both clean.
- So the promise that holds is "no write under a token older than one *that writer has seen*" (API.md's words), not "no stale write after a newer token was *granted*". The stronger form needs a fenced write to read the lock's token linearizably at the writer (a read index on `#locks`: one more round trip per fenced write).
- Proposed: P-10 says both plainly: a lease can outlast a pause by one `election.ms` per `#locks` election (or the extension is given once per lease), and a stale write can still land between a new grant and the new holder's first protected write.

**F6. No pattern needs a sixth kernel operation, atomic visibility, or the writer.** (measured here)
- Every fix above is an L2, L4 or L5 rule over the five operations.
- Atomic visibility is P-15's SHOULD only: Elle finds fractured reads (G-single) in 61 to 80 of 100 saga histories (66 to 77 with F3's rules), as API.md says (Q-A10). With F3's rules, no MUST needs it.
- Check-then-set: under the forced faults and the shuffle, the condition and op forms never sold the last item twice (cts, 300 runs), and Porcupine found every such partition linearizable. Running at the writer is still not the safety (step 2, D15). F1 is about the writer itself: judging there is linearizable only when refusals wait for the commit.

## G. Bugs step 3 found in the prototype, each fixed

| # | Where | The bug | Found by |
|---|---|---|---|
| G1 | [proto/l2.ts](proto/l2.ts) `handle` | a refusal, an empty claim and a `call-diverged` answer were sent before the log end they were judged on had committed (F1) | Porcupine on `lin-kv` calm seed 77; then [verify/phantom.check.ts](verify/phantom.check.ts) |
| G2 | [proto/api.ts](proto/api.ts) `keepSession`, `#write` | a session-bound write was sent before its session's record committed (F2) | P-13 under a forced `#sessions` leader change |
| G3 | [proto/kernel.ts](proto/kernel.ts) `electAnew` | the simulated election left the voter being replaced out of the majority count, so a 3-voter group with one dead voter never elected again (a fault-model bug, not an API one) | P-20 under a forced leader change, then the check's kill of the new leader |

Step 3 also added two fields to the client history ([proto/world.ts](proto/world.ts), [proto/api.ts](proto/api.ts): the attempt id and the write's body), so the checkers can tie a client's operation to the log. Both are marked "E-22 step 3".
