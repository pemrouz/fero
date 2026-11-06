# E-22, step 2 of 3: every pattern as an example

**Question (Q-22).** Does the proposed API ([API.md](../../../API.md)) cover every pattern on the kernel's five operations, and which patterns need atomicity across partitions, or methods at the writer? Step 1 built the prototype ([../README.md](../README.md)). This step writes every pattern on it as API.md writes it, each with a check of its guarantee under faults, builds the L5 libraries the patterns use, and runs the check-then-set race from clients.

**Words.** A *partition* is the unit of order (by default one row). A *group* holds one log with one *writer* (its leader). A *check* runs a pattern under many *seeds* (each fixes every random choice, so a run replays exactly), with *faults* injected inside the work: leader changes that can lose an uncommitted tail, a slot move (a slot is one of 1,024 buckets; a move takes it to another group), kills, pauses (a *zombie* is a process paused past its lease), clock skew, lost messages. The *shuffle* (TEST-12) delivers different partitions in a seeded random order; it is on in every check. An *attempt id* is what lets a writer answer a resend from its table (*dedup*) instead of applying it twice. *L5* is the library layer: built only from the public verbs.

## In short

- **All 22 patterns run on the API as written, with small changes, on the five kernel operations.** Twenty new examples (10 to 25 lines each; the bar is 40) join step 1's P-01 and P-14. Each type-checks against API.md's own `fero.d.ts`. Every check passes, 30 to 120 seeds each, with faults inside the work. The nine L5 libraries (`queue`, `lock`, `group`, `derive`, `saga`, `limiter`, `service`, `migrate`, `tape`; 693 lines with their helpers) needed **no sixth kernel operation**. (measured here: [results/checks.txt](results/checks.txt), [results/typecheck.txt](results/typecheck.txt))
- **But L4 lacks three things the libraries need**, each shown by a check ([../API-NOTES.md](../API-NOTES.md) part D): a caller-chosen attempt id on writes (D3: the same derive without it counted 22 cents twice over 10 of 40 runs; with it, exact in 40 of 40); a timer that runs on the world's clock (D1); and a way for a client to create a library's resource (D2).
- **Check-then-set from clients** (120 seeds): a plain read then a plain write sold the last item twice in 120 of 120 races, wherever the calls ran; a `fresh` read first did not help (120 of 120). API.md's forms (a condition, an op) never did (0 of 240). Running the calls at the writer one at a time held only while both reached the same server: with a slow handler and a failover between the calls, 120 of 120 sold twice. So conditions are the safety, and methods at the writer buy none (D15). (measured here: [checks/cts.check.ts](checks/cts.check.ts))
- **No MUST needs atomic visibility across partitions.** P-15's MUST (every saga finishes or is undone, safe against paused holders) holds with fenced locks, an intent row and per-step attempt ids: money conserved in 40 of 40 runs, a later holder took over in 25 and 28 of 40; its SHOULD (no reader sees half a unit) is not met, as API.md says (Q-A10). So X `saga` is enough for the MUSTs.
- **The checks found ten bugs in the step-1 core** (part E): a ttl timer that spun forever under clock skew, ttls lost by a slot move, a fence that forgot a released lock's token, a live view that lost its order, a lost commit notice never resent, a near-cache prefix follow that held nothing, a live session lapsed by a failover, and three more. Each is fixed in a few lines, named in the code, and step 1's checks still pass.
- **Guarantees that hold only while a writer exists:** a ttl row went 0 ms late with no failover, up to 2.0 s late with one near its ttl; a dead client's presence went within 9.8 s (lease 10 s), up to 12.4 s with a `#sessions` failover (D9). API.md should say "plus any time without a writer".

## What was built

| Part | Files | What |
|---|---|---|
| examples | `p02-…ts` to `p22-…ts` (20 files, 10 to 25 lines) | API.md §7's code, each named file an exported function. Changes from API.md are commented in the file and listed in API-NOTES D8 |
| checks | `checks/pNN.check.ts`, `checks/cts.check.ts` | one per pattern, on step 1's harness ([../proto/check.ts](../proto/check.ts)): three servers, clients, faults inside the work, the guarantee asserted, then the harness's monitors (no divergence; every caught-up replica equals a fresh fold of the committed log; no user-code throw) |
| L5 libraries | [lib/](lib) | `queue` (on `claim`), `lock` (a `#locks` row), `group` and `derive` (shares, fenced cursors), `saga`, `limiter`, `service`, `migrate`, `tape`: only `fero()` and the verbs, plus [lib/ids.ts](lib/ids.ts) (D3) |
| fake timers | [timers.ts](timers.ts) | fero test's stand-in (D1): under a world, `setTimeout` runs on the world's clock |
| type check | [checks/api-types.mjs](checks/api-types.mjs) | the examples against API.md's `fero.d.ts`, with both imports pointed at `'fero'` |
| core fixes | [../proto/](../proto) | ten, listed in API-NOTES part E |

## Every pattern, and what its check showed

Seeds: the number of seeded runs. Faults: each check puts a seeded schedule inside the work (leader changes and a slot move at least), plus what the row names. All results are measured here ([results/checks.txt](results/checks.txt)).

| Pattern | Example | Seeds | Extra faults | What the check asserts | Result | Notes |
|---|---|---|---|---|---|---|
| P-01 live state | step 1's [p01](../examples/p01-live-state.ts) | 50 | | seed once, read-your-writes, the tap, fold equality | ok | |
| P-02 cache, sessions | [p02](p02-cache.ts) | 60 | writer clock ±200 ms; a leader change near the ttl in odd seeds | removal by writer time with reason `ttl`, never early; `touch` resets; `max`; all copies agree | ok: 0 ms late calm, ≤ 2,036 ms with a failover; 9 rows of 8 in 17 runs | D8, D9, D13; E3, E4 |
| P-03 near cache | [p03](p03-near-cache.ts) | 60 | a writer changing the followed rows | one-hop miss (≤ 1 ms); `shortfall`; a follow only moves forward and ends equal; 1 KB bound held | ok | reconnect not modelled |
| P-04 read-through | [p04](p04-read-through.ts) | 60 | a write during the load (even seeds) | one `load` for six readers; the write wins | ok | |
| P-05 rooms | [p05](p05-rooms.ts) | 60 | | every socket gets its room's messages in commit order; a webserver holds only its rooms | ok | D8 (snapshot first); per-link encoding not modelled |
| P-06 pub/sub | [p06](p06-pubsub.ts) | 60 | `none` (even) or `persisted` (odd) | in order, no duplicate; persisted: every message to every subscriber | ok; `none` lost 0 of 900 | D16; `gaps` not built |
| P-07 streams | [p07](p07-stream.ts) | 60 | | a reader that stops and resumes from saved cursors gets every record once in order; `expired` with a readable `earliest` | ok | D8 (cursor brand); E5 |
| P-08 consumer groups | [p08](p08-consumer-groups.ts) | 40 | a member killed, a member paused 15 s (zombie), `#groups` and `#locks` failovers | nothing skipped; one invoice write per order; the fencing checker on every cursor row; the zombie's commit refused | ok; zombie `fenced` in 40 of 40 | D3, D16; E2 |
| P-09 work queue | [p09](p09-queue.ts) | 40 | a worker killed, a worker paused 40 s | each job removed once; the poison job dead after 5 deliveries; never two live leases (from the log); FIFO first deliveries; an empty take appends nothing | ok | D2, D6 |
| P-10 locks, election | [p10](p10-locks.ts) | 40 | the holder paused 15 s with its clock skewed ±3 s; a `#locks` failover | the zombie's write `fenced`, also on a row the newer holder never wrote; tokens rise; the ledger's fencing checker; one leader; a new one within a lease + 1 s; a paused leader's `lost` fires | ok | D11; E6, E10 |
| P-11 counters, limits | [p11](p11-counters.ts) | 60 | 5% of messages lost | the counter equals acknowledged incrs; distinct ack values; a limiter at 5: exactly 5 of 12 pass, refusals append nothing | ok | D5's window note; E8 |
| P-12 leaderboards | [p12](p12-leaderboard.ts) | 60 | | after each wave: every server's top-10, the screen's live view and the room groups equal the query; `holistic` on a near cache | ok | D12; E7 |
| P-13 presence | [p13](p13-presence.ts) | 60 | one client killed, one paused 5 s; a `#sessions` failover in odd seeds | the killed one's rows go on every copy within the bound; the others stay | ok: ≤ 9.8 s calm, ≤ 12.4 s with a failover | D9, D10; E10 |
| P-14 invariants | step 1's [p14](../examples/p14-invariants.ts) | 99 | | one `sell` of the last item; no lost `reprice` | ok | and Q-22's race below |
| P-15 sagas | [p15](p15-saga.ts) | 40 | the holder killed at a seeded step; a holder paused 25 s; a `#locks` failover | money conserved; each saga all applied or all undone; none left running; each step committed once | ok; taken over in 25 and 28 of 40 | D4, D16 |
| P-16 event sourcing | [p16](p16-event-sourcing.ts) | 60 | | the rebuilt projection equals the live one; `history: 'all'` keeps every record | ok | |
| P-17 derived | [p17](p17-derive.ts) | 40 | a member killed mid-batch; 5% loss; `#groups` and `#locks` failovers | totals equal the sums exactly | ok; without ids: wrong in 10 of 40 | D3 |
| P-18 tapes, forks | [p18](p18-tapes.ts) | 30 × 2, 20 | | a test run is a function of its seed; a tape records, finds, replays in order, and forgets past its window | ok; **fork not built** (`config`) | D14; TEST-06 open |
| P-19 clients | [p19](p19-clients.ts) | 40 | | a near-cache prefix follow holds exactly the prefix, then its changes and new rows, nothing else | ok | E9; no transport, token or bundle |
| P-20 shapes | [p20](p20-shape.ts) | 40 | the migrating server killed in odd seeds; another re-runs it | live = rebuild through upcasters at every bump (monitor); old records replay at v3; `schema` refuses; each row migrated once; pacing | ok | D8 |
| P-21 request, reply | [p21](p21-request-reply.ts) | 40 | an answerer killed in odd seeds | `no-answerer` at once; each ask its answer or `timeout`, never two | ok: 383 answers, 17 timeouts of 400; an ask 6.0 ms against 2.15 ms for a write | D7 |
| P-22 delayed jobs | [p22](p22-delayed.ts) | 40 | a writer clock skewed ±200 ms | priority 0 first; a waiting take appends nothing and wakes ≤ 3.5 ms after an enqueue; the delayed message never claimed before its time by writer time; cron at 06:00 re-adds tomorrow's | ok | D5, D6 |
| Q-22 check-then-set | [checks/cts.check.ts](checks/cts.check.ts) | 120 | a leader change inside the race in odd seeds | the condition and op forms never sell twice | ok; see below | D15 |

### The check-then-set race (Q-22's last part)

Two **clients** call one method at once. A client's call runs on the server it reached: both on the writer of the row's group, one of them, or neither (40 races each). Counted: races where both callers sold the last item.

| Form | writer + writer | writer + other | other + other |
|---|---|---|---|
| plain read, plain set | 40 of 40 | 40 of 40 | 40 of 40 |
| `fresh` read, plain set | 40 of 40 | 40 of 40 | 40 of 40 |
| `if: { version }` (API.md's `reprice`) | 0 of 40 | 0 of 40 | 0 of 40 |
| `op.incr(-1, { min: 0 })` (API.md's `sell`) | 0 of 40 | 0 of 40 | 0 of 40 |
| plain, one call at a time per row on the writer | 0 of 120 (both calls on the same server) | | |
| the same, a 3 s handler, a failover between the calls | 120 of 120 | | |

Why: a handler reads its server's committed fold and writes later; nothing ties the write to what it read except a condition. Serialising at one server closes the gap only while every call for the row reaches that server, and a failover breaks that. (Step 1 found the same with calls made on the servers themselves.)

## What this cannot show

- **A simulation**, as step 1: no sockets, disks or real clocks. P-19's transport, token checks, bundle size and cold start; P-05's encoding once per link; P-03's and P-05's reconnect with a cursor; `LogReader.gaps` and `read({ credit })`; the fork (TEST-06) and erase: not built, so not checked.
- **Outside checkers** (Porcupine, Elle: TEST-13) and **100 seeds of every check** are step 3. The checks here use 30 to 120 seeds, with the shuffle on in all. The fencing checker of TEST-13 is built in, per log, in P-08 and P-10.
- **Libraries are first versions**: the consumer group's 16 shares, the queue's 1 s poll for lapsed leases and its priority sub-partitions, and the saga's per-partition locks are reasonable, not tuned or measured for cost. No timing here.
- **The `{ id }` option** (D3) is built from L4's internals outside the core; its public form is a proposal.

## Run it

`./run.sh` (types, then every check and step 1's checks, under the study's heavy lock, into [results/](results)), `./run.sh types`, `./run.sh checks`, or one check: `node --experimental-strip-types --no-warnings checks/p09.check.ts --seeds 40` (add `--seed 7 --trace` to replay one seed). `DATA` names data's folder; data is at 63fea66 (step 1's [../fetch.sh](../fetch.sh) fetches it). Nothing is downloaded. Machine: 4 vCPU, Node 22.22.0, TypeScript 6.0.2.

## API changes this step shows

From [../API-NOTES.md](../API-NOTES.md) part D:
1. `WriteOpts.id`: a caller-chosen attempt id, so libraries can be effectively once (D3).
2. Under a world, `setTimeout`/`setInterval` run on the world's clock (D1, TEST-02).
3. A client may create a resource whose keys are all declarative; only code keys need a server (D2; replaces C1's proposal).
4. The dedup check covers the change, not its condition (D4).
5. `claim`'s `where` gets the row's write time, or an op stamps writer time, so `delay` is exact (D5).
6. `service` cannot be `none` as designed; pick a memory rung or a three-commit bar (D7).
7. Writers keep the newest token per lock after the row goes (D11); a new writer extends every lease by one election (D10).
8. A live view's stream carries data's `move` records (D12).
9. P-02, P-13: "plus any time without a writer" (D9); `rows.max` may pass by groups − 1 (D13); a tape is one partition (D14).
10. Drop `at: 'writer'` as a safety option (D15, with C5).
11. The example fixes of D8 (P-02's touch, P-05's snapshot, P-20's roll by `fero.alter`).

Q-22 (step 2 of 3): all 22 patterns run as API.md writes them (with the small changes of D8) on the five kernel operations, and every check passes under leader changes, a slot move, kills, zombies, skew and message loss; no pattern needed a sixth kernel operation, and no MUST needs atomic visibility (P-15's MUST holds with sagas); L4 must add a caller-chosen attempt id (without it, a derive double-counted in 10 of 40 runs), world timers and client-created declarative resources; check-then-set is safe only with a condition or an op, never by running at the writer (120 of 120 double sales across a failover). Moves: MIN and its K `lib` family up on P-01 to P-22, DATA-01 and TEST-12; X `saga` up (enough for every MUST); U `ldr` down on P-14 (no safety across failover); API.md changes D1 to D15 before phase 1.
