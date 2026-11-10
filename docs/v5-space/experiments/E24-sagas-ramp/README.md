# E-24: sagas with fenced locks, and RAMP

**Question (Q-24).** Do sagas with fenced locks meet P-15's MUST (every unit finishes or is undone, even with paused holders), and can RAMP meet its SHOULD cheaply?

**Threshold.** The saga holds with 3 novel rules or fewer → `saga` is enough for the MUST. RAMP holds read atomicity with 2 novel rules or fewer → P-15's SHOULD is priced at that, and X `ramp` is open to every slot row; otherwise atomic visibility is priced from published designs (Kafka's `read_committed`, Percolator).

**In short.**
- **The saga as DESIGN-V5 5.3 writes it does not meet P-15's MUST** (model-checked). Two units make a write cycle (G0, 17 steps; E-22's finding, now exhaustive). And a paused holder's late step lands after its unit was recorded `undone` (12 steps).
- **E-22's two rules (F3) remove the write cycle, not the late step.** With them (option `owned`), all-or-nothing still breaks in 12 steps, once a refused step's data may change.
- **Writers following `#locks` is not enough, and not needed.** Not enough: the draft leans on "the lease margin covers the follow lag", and a paused holder's write can be later than any margin. Not needed: three designs hold on all seven bounds (up to 2.9 million states, each explored in full) with no following at all. Each makes one thing true: **whoever ends a unit has written every one of its partitions with its own token.**
  - `fullundo`: a failed run undoes every step, applied or not. Free on the happy path.
  - `bump`: a holder raises the fence at every partition before it acts (Kafka's epoch bump). One extra write per partition per saga.
  - `raise`: a refused step still raises the fence. A kernel change.
- **The count for `fullundo` (DEV-10):** 38 rules needed, each with a counterexample, of 60 written; 41 of 44 non-equivalent mutants caught (93%). All but one have a published source (fenced locks, the saga log, Percolator's "resolve the other first"). The one new rule is "undo every step"; its nearest precedent is Kafka's end markers. So the saga meets the MUST with **1 novel rule**, inside the threshold of 3.
- **RAMP-Fast keeps read atomicity for plain writes with 1 novel rule** (a round-2 fetch of a pending version commits it), across a client crash, a lagging follower, garbage collection and a slot move (model-checked; 19 rules; 20 of 20 mutants). A read costs one round, or two when a unit is mid-commit (8 to 12% of reads in the simulation), never three.
- **RAMP-Fast is not enough for fero's operations.** Real Elle finds a fractured read (G-single) in RAMP-Fast histories of list appends, and a direct count finds 10 in 36,000 reads. A `push` or `incr` version carries earlier units' effects, which its metadata does not name. The fix (`rampv`: a small vector on each version, and round 2 repeated) leaves none in 36,000 reads and none in 200 Elle-checked histories. But it costs at least 2 more novel rules and has no fixed bound on rounds: above the threshold of 2.

## Words used here

- A **unit** is one transaction across partitions: here, a list of steps, each on one partition, in key order. A **saga** runs a unit step by step; readers may see the steps one at a time.
- A **lock** is a row in `#locks`. Claiming it gives a **token** (the lock row's new version). A **lease** keeps the lock; when it **lapses**, someone else may claim it, with a higher token.
- A **fence**: a write carries its lock's token, and the partition's writer refuses a token below the highest it has seen for that lock. Each group keeps its own table of highest tokens (a **fence table**).
- **Writers follow `#locks`**: each group's writer also reads `#locks` and refuses a token below the lock's current version that it has seen (DESIGN-V5 5.3). The question calls this **fences across groups**.
- The **intent row** (in `#sagas`) records a unit and its direction: `run`, `undo`, then `done` or `undone`.
- A **paused holder** (a zombie) is a holder whose lease lapsed while it was stopped (a GC pause, a VM stall). It does not know, and it may send a write with its old token later.
- A **later holder** is whoever calls `saga(steps, { id })` again with the same id (the app's retry), or a holder of another unit that resolves this one first.
- **G0** (a write cycle): unit U is before unit V in one list and after it in another. **A fractured read**: a reader sees part of a unit (one of its writes, but an older value where the unit also wrote); Elle reports it as **G-single**.
- **RAMP-Fast** (Bailis et al., SIGMOD 2014): a unit's writes carry its id and its sibling partitions; they go in two rounds, *prepare* (kept, but invisible) and then *commit markers*; a reader that sees a unit's write at one partition and an older value at a sibling fetches the unit's exact version there, by its id, in a second round.
- **DEV-10**: a **rule** is one guard conjunct or one state update in a model action, counted only if removing it lets the checker find a counterexample (ablation). **Mutants** are made by script: drop each guard, drop each update, flip each `<`, `<=`, `>`, `>=`, swap each pair of updates in one action.
- **AG EF**: "from every reachable state, the goal can still be reached" (the liveness check of E-14, E-16 and E-17).

## Method

Two exhaustive models in plain Python, on E-16's engine ([../E16-controller-loop/engine/engine.py](../E16-controller-loop/engine/engine.py)), which uses E-17's shared rule language (`harness/dsl.py`) unchanged and E-17's ablation and mutant procedure, as E-33 does. Each model brings its own small world: E-17's world is about partitions that move between groups, and has no locks, holders or readers. Every run is breadth first over every reachable state, so every trace below is a shortest one. Rule counts here compare only with each other (QUESTIONS, "Counting").

Then a seeded simulation writes list-append histories with concurrent readers, and **real Elle 0.2.8** checks them (the question asks for Elle; the exhaustive models have no concurrent readers for sagas).

### 1. The saga ([models/saga.py](models/saga.py))

**The world (not counted).**
- Data partitions p and q (and r in one bound), each in its own group, so a unit's steps land in up to three groups. `#locks` and `#sagas` share one more group, M. Every group is an abstract Raft group with one writer: a write is judged and applied at once, and the answer reaches the caller in the same step. E-14 and E-15 check Raft and moves; this model asks what the saga library needs on top.
- A unit's step i appends the unit's id to the list at its partition (Elle's list-append, the form E-22's P-15 workload writes). An append is "push if absent", so it is idempotent, and its undo removes the id. A re-run of a step that is applied answers its first outcome (dedup by attempt id). A step's condition may fail (budget). The writer judges it against the data when the write arrives. A refused step is refused again until its data changes (a **top-up**: a budget is topped up); after a top-up it may pass, for any holder, a paused one included. A re-run of a step that is applied answers "applied", never a refusal.
- Each unit has an original holder (`a`, which never restarts) and a later holder (`b`, the app calling `saga(steps, { id })` again; it restarts after a crash).
- **Faults** (budgets): a crash at any point; a lease that lapses while its holder is alive (the paused holder, who acts later with its old tokens); a step whose condition fails; a top-up of a refused step's data. A crashed or finished holder's lease lapses with time. In the options that follow `#locks`, each writer's view of `#locks` lags by any amount (a calm step brings it up to date).

**The saga program (counted, DEV-10).** Claim the unit's locks in key order (a claim succeeds if the lock row is absent or lapsed; the new version is the token). Read `#sagas`: begin (write the intent `run` if absent), continue a unit found unfinished in its recorded direction, or skip a unit already ended. Run each step under its partition lock's fence; on a failed condition record `undo` and undo. Record `done` or `undone`. Every write to M carries the holder's tokens and M checks them against the lock rows. A holder that finds its lock has a newer version gives up, releases what it still holds, and retries.

**The options.**

| Option | What it is |
|---|---|
| `draft` | DESIGN-V5 5.3 as written: steps fenced by the partition lock; each group keeps the highest token per lock; **writers follow `#locks`** with lag and refuse a token below the version they have seen; a later holder continues an unfinished unit; a failed step undoes the steps before it. |
| `owned` | `draft` plus E-22's F3: a holder that finds another unit unfinished on its partitions resolves it first (or, if it lacks that unit's locks, releases its own and waits); it begins its own unit only when none is unfinished there. |
| `bump` | `owned`, **with no following of `#locks`**: after claiming its locks, a holder raises the fence at every partition of its unit before it reads `#sagas` (Kafka's KIP-98 epoch bump, which fences a zombie producer at every partition of its open transaction). |
| `fullundo` | `owned`, with no following and no bump: a failed run undoes **every** step, the failed one and those after it too. Each undo is a write, so it raises the fence there. |
| `raise` | `owned`, with no following: a step refused by its condition still raises the fence (a kernel change: the refusal commits a record). |

**Properties.**

| Id | Property |
|---|---|
| A1 | All or nothing: a unit recorded `done` has its id in every list of its steps; one recorded `undone` in none. Checked in every state, so a paused holder's late write after the end is caught. |
| A2 | No write cycle between units (Elle's G0): two units in the same two lists are in the same order in both. |
| L1 | AG EF: every unit can end `done` or `undone` once faults stop. It asks every unit to end, not only those begun, so a model that never begins a unit fails. A top-up is a fault, so once faults stop a refused step stays refused: a unit with a refused step can end only by its undo (a holder that kept retrying the step would never end). |

**Bounds.**

| Bound | Units | Holders | Crashes | Paused leases | Failed conditions | Top-ups |
|---|---|---|---|---|---|---|
| `one` | 1 on p, q | a1, b1 | 1 | 1 | 1 | 1 |
| `two` | 1 and 2, both on p, q | a1, a2, b1 | 0 | 1 | 0 | 0 |
| `sub` | 1 on p, q; 2 on q | a1, a2, b1 | 0 | 1 | 1 | 1 |
| `three` | 1 on p, q, r | a1, b1 | 1 | 2 | 1 | 1 |
| `one2` (verify) | 1 on p, q | a1, b1 | 2 | 2 | 1 | 1 |
| `two-f` (verify) | 1 and 2 on p, q | a1, a2, b1, b2 | 1 | 1 | 1 | 1 |
| `sub-f` (verify) | 1 on p, q; 2 on q | a1, a2, b1, b2 | 1 | 1 | 1 | 1 |

### 2. RAMP-Fast ([models/ramp.py](models/ramp.py))

**The world (not counted).** Partitions p and q, each in its own group with one writer. A writer keeps, for its partition, the versions it holds (by unit id), the units whose commit marker it has, and lastCommit. A follower is a copy of the writer's state from some earlier moment (a fold of a prefix of its log); a calm step brings it up to date. Units are blind writes (RAMP's own setting); each unit's client prepares at each partition, then, once every prepare is acked, writes a commit marker at each. A client may crash at any point. One reader runs two read transactions over p and q, one after the other. Garbage collection (a timer, not calm) may drop versions by its rules. In one bound q moves once to a new group at any moment; the new group starts from what the move carries (each part of the state is its own update, so the ablation says which are needed; E-15 checks the move itself).

**The rules (counted).** The client: prepare; commit markers only after every prepare is acked; a marker raises lastCommit only if newer (RAMP's `max`). The reader: round 1 returns lastCommit at each partition (from the writer or a follower), and a server answers only once its fold is at least what this process saw there (fero's read rule, API.md "Reads"); round 2 is planned from round 1 and fetches the exact version a sibling names, from any replica that holds it; a version the writer no longer holds restarts the read; a read finishes only when no sibling names a newer unit than it holds. The writer: garbage collection keeps the lastCommit version and every pending one. The fero additions: a round-2 fetch of a pending version commits it at the writer (`serve`); a slot move carries pending versions, committed versions, markers and lastCommit.

**Options.** `ramp` (as above) and `noserve` (no commit on a round-2 fetch).

**Properties.**

| Id | Property |
|---|---|
| RA | Read atomicity: a finished read that holds unit T's version of x, where T also wrote y (ground truth, not the version's metadata) and y was read, holds T's version of y or a newer one. |
| R2 | At most two rounds: round 2 fetches only what round 1 planned. |
| MONO | A reader's second read never returns an older version than its first (fero's promise). |
| KEEP | The version lastCommit names is kept (round 1 always finds it). |
| V | AG EF: every unit some reader returned reaches, at each partition it wrote, a lastCommit at or above it (nothing seen is undone). |
| W | AG EF: every unit whose client is alive is written (so a model that never writes fails). |
| L | AG EF: every read finishes. |

**Bounds.** `two` (units 1 and 2 on p, q; one client crash; two reads), `fol` (unit 2 on q only; q has a follower), `gc` (garbage collection), `move` (q moves); verify: `fol-move` (three units), `gc-move`. `gc-fol` passed 3 million states without an end, so it cannot decide a run: it is run once, as a partial check, on `ramp`.

### 3. Elle ([elle/sim.py](elle/sim.py), [elle/check.clj](elle/check.clj))

A seeded random simulation, built from the rules the models check: units over 2 or 3 of three partitions, under locks taken in key order and owned by the unit until it ends; a holder may crash between any two steps and a later holder finishes or undoes the unit; a step's condition may fail (then every step is undone, as `fullundo`). Three readers read 2 or 3 partitions per transaction, one partition per step, so writes land between their reads. Three visibility modes: `plain` (each step visible at once: the saga as DESIGN-V5 5.3 builds it), `ramp` (each step is a RAMP prepare; once every prepare is acked the unit gets a timestamp and commit markers go out one by one; readers do RAMP-Fast's two rounds), and `rampv` (`ramp` plus the fix found below: each version carries a small vector, and the reader repeats round 2 until nothing is missing). 100 histories for each mode at a failure rate of 0 and of 0.15 per step (600 in all), and 1,000 more per row for `ramp` and `rampv` for a direct count of fractured reads (4,000). Each unit is one Elle transaction of appends (`:ok` if it ended done, `:fail` if undone or aborted); each read is one transaction of reads. Real Elle 0.2.8 (`elle.list-append`) checks each history at `:read-committed` (P-15's MUST: no G0, G1a, G1b, G1c, lost or doubled element) and at `:serializable` (which adds G-single, the fractured read).

## Results

### 1. The saga: which designs hold (model-checked here, [results/design-saga.txt](results/design-saga.txt))

| Option | one | two | sub | three | one2 | two-f | sub-f |
|---|---|---|---|---|---|---|---|
| `draft` | A1, 12 steps | A2, 17 steps | A1, 12 steps | A1, 14 steps | A1, 12 steps | A1, 12 steps | A1, 10 steps |
| `owned` | A1, 12 steps | holds | A1, 11 steps | A1, 14 steps | A1, 12 steps | A1, 12 steps | A1, 10 steps |
| `bump` | holds | holds | holds | holds | holds | holds | holds |
| `fullundo` | holds | holds | holds | holds | holds | holds | holds |
| `raise` | holds | holds | holds | holds | holds | holds | holds |
| states (`fullundo`) | 13,373 | 1,858 | 9,916 | 391,613 | 354,098 | 2,205,596 | 1,153,221 |
| seconds (`fullundo`) | 0.7 | 0.1 | 0.5 | 23.8 | 19.5 | 152.6 | 78.8 |

`bump` explores 14,529 / 2,628 / 11,046 / 368,929 / 370,595 / 2,902,536 / 1,572,041 states on the same bounds, `raise` 11,490 / 1,858 / 9,126 / 327,109 / 307,736 / 2,042,268 / 1,045,794. Every run that holds is complete (every reachable state explored); a run that breaks stops at its first, shortest counterexample. All of `fullundo`'s runs together take under 5 minutes on one core.

**A note on the model, and when `owned` would be enough.** How a refused step behaves later decides what the checker can see, and two earlier versions of this model got it wrong in opposite ways:
- **A refusal final for good** (refused again for every later holder, whatever happens to the data). That forbids exactly the paused holder's late step, so it hides the A1 trace below: in that version `draft` broke only A2 and `owned` held on `one`, `two` and `sub` ([results/design-saga-sticky.txt](results/design-saga-sticky.txt), a partial run).
- **A refused step free to pass at any time.** Then liveness can be met by retrying a refused step until it passes, so nothing forces an undo: that version's ablation dropped every lock, fence and undo rule and kept 13 rules of a saga that never undoes (model-checked here, output kept in `$SP/e24/stale2/`, not in the repo).

The model now makes the change of data a fault with a budget (a **top-up**): the checker sees the paused holder's late step after a top-up, and liveness must hold when a refused step stays refused. So `owned` is enough only for apps whose step conditions never change their answer, which `saga` cannot know.

**The draft's write cycle (A2, G0), 17 steps: E-22's finding, now exhaustive.** Holder a1 claims p and q and pauses; its lease lapses. It wakes and begins unit 1 with its old tokens (nobody has claimed since, so `#sagas` accepts). Holder a2 claims both locks (tokens 2) and begins unit 2; the draft does not look at unit 1. a1, still paused in its own mind, appends 1 at p with token 1: p's writer has not yet followed `#locks` to version 2 and has seen no token for p, so it accepts. a2 appends 2 at p and at q and ends. Later holder b1 (tokens 3) finds unit 1 unfinished and finishes it: 1 goes to q. Now p is [1, 2] and q is [2, 1]: unit 1 is before unit 2 on p and after it on q.

**The paused holder's write after an undo (A1), 12 steps: it breaks both `draft` and `owned`.**
1. a1 claims p and q (tokens 1), and pauses; its lease lapses.
2. b1 (the app retrying the same saga id) claims both (tokens 2) and begins the unit.
3. a1 wakes, reads `#sagas`, finds the unit running, and continues it.
4. b1's step at p is refused by its condition. A refused write commits nothing, so p's writer never sees token 2.
5. p's data changes (a top-up), so the same step would now pass.
6. a1 appends at p with token 1. p's fence is 0 and p's writer has not yet followed `#locks` to version 2, so it accepts.
7. b1 records `undo`; its failed step was the first, so it has nothing to undo, and it records `undone`.
8. The unit is `undone`, yet its id is in p's list.

The draft's answer to this is "every shard's writer follows `#locks`" (DESIGN-V5 5.3), with the claim that "the holder's lease margin (a round trip plus `skew.max`) covers" the follow lag. In this model the lag is any length, as it is for a paused process: a pause can outlast any margin, and a write can sit in a socket buffer. So **following `#locks` is not enough** without a bound on message delay. It is also **not needed**: `bump`, `fullundo` and `raise` hold on every bound with no following at all. All three make the same thing true: **whoever ends a unit has written every one of its partitions with its own token**, so a paused holder's later write is refused by that partition's own fence table.
- `fullundo` gets it free on the happy path: a forward run writes every partition anyway, and an undo now undoes every step, applied or not.
- `bump` pays one extra write per partition on every saga.
- `raise` needs a kernel change (a refusal that commits a fence record).

**DEV-10 for `fullundo`** ([results/saga-fullundo-ablation.json](results/saga-fullundo-ablation.json), [results/summary.md](results/summary.md)). **38 rules needed, each with a counterexample**, of 60 written (one more, `fail.count`, is a pinned world step). Three more are kept undecided (below), so the smallest model has 41. It holds on the four sweep bounds and on the verify bounds `one2` (293,460 states) and `two-f` (2,432,844), each complete. On `sub-f` it passes 3,000,001 states with no counterexample and does not finish; the design itself holds there in full (1,153,221 states). The ablation took 633 runs and 3.5 CPU hours. The same rules by mechanism, with each precedent: [results/count.md](results/count.md).

| Group | Rules needed | Published or novel |
|---|---|---|
| Locks with tokens (6) | `claim.seq`, `.lock`, `.tok`, `.pc`: claim in key order; the lock row's new version is the token. `giveup.release`, `.pc`: a holder that finds a newer version releases what it still holds and starts again | published: Chubby's sequencers (Burrows, OSDI 2006); fencing tokens ([Kleppmann 2016](https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html)) |
| The saga and its intent row (16) | `begin.absent`, `.intent`; `step.seq`, `.data`, `.pc`; `fail.seq`, `.pc`; `decide.seq`, `.intent`, `.pc`; `undo.seq`, `.data`, `.pc`; `close.seq`, `.intent`, `.pc`: write the intent if absent; run the steps; on a refusal record `undo`, then undo backwards; record the end | published: Garcia-Molina and Salem, "Sagas" (SIGMOD 1987): the saga's log records and backward recovery. **One part is new: where the undo starts** (inside `decide.pc`; see below) |
| A later holder continues (4) | `adopt.seq`, `.unfin`, `.tgt`, `.pc`: whoever finds an unfinished intent continues it in its recorded direction | published: the same paper's recovery |
| Fences (6) | at `#sagas`: `decide.holds0`, `.holdsN`, `close.holds0`, `.holdsN` (a write of the direction or the end carries the lock tokens, and is refused below the lock rows' versions). At a partition: `step.fence` (a step is refused below the highest token seen), `undo.raise` (an undo raises it) | published: the storage side of a fencing token (Chubby; Kleppmann) |
| Resolve the other unit first, F3 (6) | `begin.noother`: begin only when no other unit is unfinished on my partitions. `other.seq`, `.unfin`, `.tgt`, `.pc`: resolve it first, with my tokens. `backoff.release`: if I lack its locks, release mine | published: Percolator (Peng and Dabek, OSDI 2010): a transaction that meets another's lock rolls it forward or back first. E-22 found the need (its F3) |

- **The one new rule: a failed run undoes every step.** It is not a separate line of the model: it is where `decide.pc` starts the undo (at the unit's last step, not at the step before the failed one). The design check counts it: `owned` is `fullundo` without it, and breaks A1 in 12 steps. No published saga undoes steps that never ran; here the undo is also the write that raises each partition's fence. Its nearest precedent is Kafka: the transaction coordinator writes an end marker to every partition of the transaction ([KIP-98](https://cwiki.apache.org/confluence/display/KAFKA/KIP-98+-+Exactly+Once+Delivery+and+Transactional+Messaging)), and the producer epoch rises at every end, so a late write of the ended transaction is refused ([KIP-890](https://cwiki.apache.org/confluence/display/KAFKA/KIP-890%3A+Transactions+Server-Side+Defense)). Both are cited from memory, not re-read here. If the judges accept that as "the same state and the same rules in the same role" (DEV-10 b), the novel count is 0; this report counts **1**.
- **What each removal breaks** (the summary has every line): without `step.fence` or `undo.raise`, the paused holder's late step lands after `undone` (A1, 15 steps). Without `begin.noother` or `other.unfin`, the write cycle is back (A2, 13 and 11 steps). Without a fence at `#sagas` (`decide.holds*`, `close.holds*`), a paused holder records the wrong direction or the wrong end (A1, 13 steps).
- **Three guards are kept without a counterexample**: `claim.free` (claim only a lock that is absent or lapsed), `giveup.lost` (give up only when fenced) and `backoff.blocked` (back off only when blocked). With one of them dropped a holder may claim, give up or back off at any time; tokens then grow without end, and the run passes 3,000,000 states with no counterexample. A targeted check with tokens capped at 4 ([steal_check.py](steal_check.py), [results/steal-check.txt](results/steal-check.txt)) visits every reachable state without each of them (up to 1.9 million states, each complete): A1 and A2 hold. So safety does not need them: the fences make a stolen lock safe. What they give is progress (two holders that steal from each other for ever never finish), which is a fairness property this kind of liveness check ("a path exists") cannot show. They are counted as kept, not as proven needed.
- **Dropped (19), and why.**
  - `begin`'s own program steps and its fences (`begin.seq`, `.tgt`, `.pc`, `.holds0`, `.holdsN`): once the intent is written, "continue the intent you find" runs it. The first run is the recovery path. And an intent written by a holder that lost its locks is run by whoever holds them (F3).
  - The waiting loop around F3 (`adopt.noother`, `retry.*`, `backoff.seq`, `.holds0`, `.holdsN`, `.pc`), and `skip.*` (a holder that finds its unit ended has nothing left to do).
  - One half of each fence pair (`step.raise`, `undo.fence`, `fail.fence`): steps are checked against the fence, and undos raise it. A step here is an idempotent append, so a late step after `done` changes nothing; with steps that are not idempotent, dedup by attempt id does that job (E-20, E-30).
  - So the smallest model is not a program to ship. It says which rules the properties need. In the design as written, 46 of the 60 rules are needed alone (4 of them only by the state limit).
- **Mutants: 56 made from the smallest model; 41 caught, 12 equivalent, 3 undecided, none survived; 41 of 44 non-equivalent (93%).** The 38 needed drops and all 3 flips are caught. The 12 swaps change nothing: each has the same state digest as the smallest model on every bound ([resolve24.py](resolve24.py) compares them; the engine had left them "undecided" because `sub-f` stops at the state limit before it compares). The 3 undecided are the drops of the three guards above.

### 2. RAMP-Fast (model-checked here, [results/design-ramp.txt](results/design-ramp.txt))

| Option | two | fol | gc | move | fol-move | gc-move | gc-fol |
|---|---|---|---|---|---|---|---|
| `ramp` | holds | holds | holds | holds | holds | holds | none in 3 M states (partial) |
| `noserve` | L, V | L, V | holds | V | L, V | V | not run |

States (`ramp`): 3,344 / 5,114 / 845 / 1,008 / 294,450 / 20,730 on `two` to `gc-move`, each complete, in 29 seconds together; `gc-fol` stopped at the 3,000,002-state limit after 183 seconds with no counterexample (a partial check: it says only that no property breaks in the first 3 million states, breadth first).

- **Read atomicity (RA), at most two rounds (R2), monotonic reads (MONO) and KEEP hold** on every bound, with a client crash between prepares and markers, a lagging follower, garbage collection and a slot move (register semantics: a version is its unit's value; see 3 for operations).
- **A crashed client leaves its unit half committed, and a reader can see it.** `noserve` fails L in 4 steps and V in 9: unit 2 prepares at p and q, commits at p, and its client crashes. A reader sees 2 at p and fetches q's pending version 2 in round 2, as RAMP says. But q's lastCommit stays at 0 forever, so the same process's next read of q (which must not go back, fero's read rule) waits forever (L), and any other reader of q alone sees the older value (V: what one reader saw is undone for the next). RAMP's paper leaves completing a failed client's commit to recovery; here, **a round-2 fetch of a pending version commits it at the writer** (two updates: the marker and lastCommit), and every property holds.

**DEV-10 for `ramp`** ([results/ramp-ablation.json](results/ramp-ablation.json), [results/summary.md](results/summary.md)): **19 rules needed** of 42 written (2 more are pinned world steps), and 20 of 20 non-equivalent mutants caught (25 made; 4 swaps and the flip of `commit.newer` are equivalent). The smallest model holds on the verify bounds `fol-move` (184,512 states) and `gc-move` (9,752), each complete.

| Group | Rules needed | Published or novel |
|---|---|---|
| RAMP-Fast's writer | `prepare.vers`, `prepare.ack`, `commit.allprep` (markers only after every prepare is acked), `commit.newer` (lastCommit only moves up), `commit.last` | published (Bailis et al. 2014, Algorithm 1) |
| RAMP-Fast's reader | `r1.unread`, `r1.get`, `plan.all`, `plan.plan`, `r2.stage`, `r2.get`, `finish.stage`, `finish.complete`, `finish.next` | published (Algorithm 1) |
| fero's read rule | `r1.mono` (a server answers round 1 only once its fold has reached what this process saw there), `finish.seen` (the process remembers the newest version it saw) | not new with RAMP: fero's rule for reads from any replica (API.md "Reads"; W `any`), needed here as soon as a follower may answer round 1 (without either, MONO breaks on `fol` in 10 steps) |
| **serve** | `r2.last`: a round-2 fetch of a pending version raises lastCommit at the writer (completes a crashed client's commit) | **novel, 1 rule** (the paper leaves a failed client's commit to recovery) |
| the slot move's copy | `move.pending` (carry pending versions), `move.last` (carry lastCommit) | 2 conditions on fero's own move (E-15's carried state): novel only if the move does not already copy every stored version |

- Dropped, and why: garbage collection (`gc.*`) drops out because no property needs it to run. When it runs, its guard "keep the lastCommit version" (`gc.older`) is needed: dropped alone, KEEP breaks in 4 steps (counted by reasoning: **1 more rule**, published as RAMP's own GC rule). Its other guard, "keep a pending version until its marker" (`gc.committed`), is not needed at these bounds: the model holds on `gc` and `gc-move` without it (1,146 and 35,672 states), because a reader that asks for a collected version restarts its read. `r2.commit` (the marker) drops out: raising lastCommit alone is enough. The restart path (`restart.*`) drops out with garbage collection. `commitold.*` (a marker older than lastCommit) and the set of markers itself (`commit.com`, `move.com`) drop out: round 1 needs only lastCommit, and a marker older than lastCommit changes nothing a reader can see.
- **So RAMP-Fast holds read atomicity in register semantics with 1 novel rule** (serve), plus the move's copy carrying pending versions and lastCommit. **For fero's operations it needs `rampv`'s vector** (section 3): at least 2 more rules (stamp each version with the newest unit per co-written sibling; repeat round 2 while one names a newer unit), one more novel mechanism, and no fixed bound on rounds. That count is reasoned from the simulation, not model-checked: the exhaustive model has register semantics only.

### 3. Elle (real Elle 0.2.8, [results/elle.md](results/elle.md), [results/elle-sim.txt](results/elle-sim.txt))

| Histories | n | read committed valid (MUST) | serializable valid | anomalies (histories with it: cases) | reads needing a second round |
|---|---|---|---|---|---|
| plain-f00 | 100 | 100 | 3 | G-single 97: 207 | 0 of 1,800 |
| plain-f15 | 100 | 52 | 7 | G-single 84: 137; G1a 48: 166; incompatible order 27: 31 | 0 of 1,800 |
| ramp-f00 | 100 | 100 | 99 | G-single 1: 1 | 208 of 1,800 (11.6%) |
| ramp-f15 | 100 | 100 | 100 | none | 150 of 1,800 (8.3%) |
| rampv-f00 | 100 | 100 | 100 | none | 210 of 1,800 (11.7%) |
| rampv-f15 | 100 | 100 | 100 | none | 150 of 1,800 (8.3%) |

`f00` and `f15` are the failure rates 0 and 0.15 per step. No read needed a third round in any row (most rounds in one read: 2).

- **The plain saga meets the MUST and not the SHOULD, as expected.** With no failed conditions, every history is valid at read committed: no G0 between units, no lost or doubled element. But readers see units half done (G-single) in nearly every history. With failed conditions, readers also see appends that are later undone (G1a, an aborted read) and lists that lose an element (incompatible order): a saga's undo is visible, which is what "readers can see the intermediate states" means (E-22 saw the same).
- **RAMP-Fast removes almost every fractured read, but not all.** Real Elle found one G-single in 200 RAMP histories ([results/ramp-f00-069.edn](results/ramp-f00-069.edn)). It is real, and it is a property of RAMP-Fast, not of the simulation: unit 9 appended to keys 0 and 1, then unit 6 appended to keys 1 and 2. A reader got key 1 at unit 6's version, whose list is [2, 3, 9, 6]: it includes unit 9's append. RAMP-Fast's metadata on that version names only unit 6's siblings (keys 1 and 2), so the reader never asks for key 0 at unit 9, and it returns key 0 as [3], without 9. RAMP assumes a version is only its writer's value (a register). fero's operations (`push`, `incr`, `merge`, `max`, `min`) make a row's value carry every earlier unit's effect, so the version names more units than its writer. A direct count over 1,000 histories per row ([elle/fractured.py](elle/fractured.py), [results/fractured-1k.txt](results/fractured-1k.txt)): `ramp` returns a fractured read in 6 of 18,000 reads (5 histories) with no failures and 4 of 18,000 (3 histories) with failures; rare, but not zero.
- **The fix, `rampv`: each version carries, for each sibling partition, the newest unit it includes that also wrote there** (a small vector, one entry per partition co-written with this one), and the reader repeats round 2 until nothing more is needed. Real Elle finds nothing in its 200 histories ([results/rampv-f00-069.edn](results/rampv-f00-069.edn) is the same seed as the `ramp` history above), and the direct count finds no fractured read in 36,000 ([results/fractured-1k.txt](results/fractured-1k.txt)). It costs one more novel mechanism (the vector), and the read is no longer bounded at two rounds: a fetched version can name a newer unit at a third partition (a chain through one partition). None of 36,000 reads needed a third round here ([results/elle-sim-1k.txt](results/elle-sim-1k.txt)); 11.7% needed a second, as for plain RAMP-Fast. But the bound is the length of such a chain, not 2.



## What the models leave out

- **Raft, elections and slot moves inside a group.** Each group is an abstract linearizable writer; E-14, E-15 and E-17 check those layers. A slot move appears only in the RAMP model, as one atomic step; the saga's fence tables are carried by a move as DESIGN-V5 4.2 says, which E-15 checks.
- **Unclean recovery** (a committed write lost). Under it, a fence table can go back; E-15 and slot_move.py show the recovery rules that keep positions and tokens from repeating.
- **Time.** Leases lapse by a free choice, not by clocks; nothing here depends on a clock bound. That is the point: the model shows which rules are safe with *no* timing assumption. A design that leans on "the lease margin covers the follow lag" is safe only under a timing bound the model does not grant.
- **Operations that are not idempotent** (`incr`, `push` of a value already there). The model's steps are idempotent appends; a real step relies on dedup by attempt id for a re-run, and E-20 and E-30 check dedup and its horizon. A step whose effect cannot be inverted cannot be undone at all (E-22's F4: `saga` refuses such a step).
- **Readers inside the saga model.** The saga's MUST does not speak of readers; readers (and fractured reads) are checked by the RAMP model and by Elle.
- **Saga steps with conditions under RAMP.** The RAMP model has blind writes, as RAMP does. The Elle simulation runs RAMP under the saga's locks, with failed conditions aborting the prepares; it is a simulation, not an exhaustive check.
- **Bounds.** At most two units with two holders each, three partitions, two faults of a kind. The verify bounds add a fault or a unit.

## Against the threshold

The threshold: "The saga holds with ≤ 3 novel rules → `saga` is enough for the MUST. RAMP holds read atomicity with ≤ 2 novel rules → P-15's SHOULD is priced at that, and X `ramp` is open to every slot row; otherwise atomic visibility is priced from published designs (Kafka's `read_committed`, Percolator)."

- **The saga holds with 1 novel rule, so `saga` is enough for the MUST. But not as drafted.** DESIGN-V5 5.3 needs three changes:
  1. Add E-22's F3: a holder resolves another unit's unfinished intent on its partitions first, and begins its own unit only when none is unfinished there. This removes the write cycle.
  2. Add "a failed run undoes every step, the failed one and those after it too" (`fullundo`), or the epoch bump (`bump`). Either makes the ender's token the newest at every partition of the unit, so a paused holder's late write is refused there.
  3. Drop "every shard's writer follows `#locks`" as the saga's protection. It is not enough without a bound on message delay, and with change 2 it is not needed.
- **Do writers have to follow `#locks` (fences across groups)? No.** SPACE counts that as X `saga`'s one novel mechanism. It leaves the count, and "undo every step" takes its place: the count stays 1 (or falls to 0 if Kafka's end markers are accepted as its precedent).
- **RAMP: inside the threshold for plain writes, above it for operations.**
  - Units of plain `set`s: read atomicity holds with 1 novel rule (serve), plus two items a slot move must carry (pending versions and lastCommit). So P-15's SHOULD is priced at that for such units, and X `ramp` is open to every slot row for them. A read costs one round, or two when a unit is mid-commit.
  - Units with operations (`push`, `incr`, `merge`, `max`, `min`; E-22's P-15 workload is list appends): RAMP-Fast leaves fractured reads. The fix needs at least 3 novel rules in all (serve, the vector stamp, the repeated round) and loses the two-round bound. That count is reasoned from the simulation, not model-checked. It is above 2, so by the threshold's "otherwise" branch atomic visibility for such units is priced from published designs (Kafka's `read_committed`, Percolator).
  - Either way, RAMP's writes take two rounds (prepare, then markers) under the saga's locks, and each partition keeps a pending version until its marker.
- **Elle.** The question expected no fractured read for RAMP. Real Elle found one in 200 RAMP-Fast histories; it is a property of RAMP-Fast on operations, not of the simulation (section 3).

## How to rerun

```sh
./run.sh          # everything (about 4 CPU hours: the saga's ablation is 3.5 of them, in 25-minute holds)
./run.sh check    # every option of both models on every bound, with traces (about 20 minutes)
./run.sh elle     # the simulated histories, real Elle on 600 of them, the direct count on 4,000
./run.sh report   # results/summary.md from the ablation files
python3 ../E16-controller-loop/engine/cli.py models/saga.py owned --bound one    # one run, with its trace
```

## Files

- [models/saga.py](models/saga.py), [models/ramp.py](models/ramp.py): the models. [run.sh](run.sh): every run above. [fetch.sh](fetch.sh): checks the Elle jars (fetched by E-22b).
- [resolve24.py](resolve24.py): settles the saga's swap mutants by state digest, from the ablation's cache. [steal_check.py](steal_check.py): the saga's three lock guards with tokens capped. [count.py](count.py): the kept rules by mechanism, each with its precedent.
- [elle/sim.py](elle/sim.py), [elle/check.clj](elle/check.clj), [elle/summarize.py](elle/summarize.py), [elle/fractured.py](elle/fractured.py): the histories, real Elle, the table, the direct count.
- [results/](results): the design runs with traces (`design-saga.txt`, `design-ramp.txt`; `design-saga-sticky.txt` is the earlier model's partial run, kept as a record), `steal-check.txt`, the ablations (`saga-fullundo-ablation.json`, `ramp-ablation.json`; each also leaves a `.cache` of every run it made beside it, which git ignores), `summary.md` (the rule tables and mutants), `count.md` (the kept rules by mechanism and precedent: this agent's count; DEV-10 e asks a second agent to count on their own), Elle's verdicts (`elle.md`), the simulations' read rounds (`elle-sim.txt`, `elle-sim-1k.txt`), the direct count (`fractured-1k.txt`), and four histories (`plain-f00-000`, `ramp-f00-000`, `ramp-f00-069` with the fractured read, `rampv-f00-069` the same seed under the fix).
- Machine: Ubuntu 24.04 in a Firecracker VM, 4 vCPU, 15 GB RAM; Python 3.13.17; OpenJDK with Elle 0.2.8 and Clojure 1.12.0. Every run held `$SP/bin/heavy` (shared) while other agents' jobs ran, so the seconds are not timings.

Q-24: Sagas with fenced locks meet P-15's MUST, but not as drafted. DESIGN-V5 5.3 makes a write cycle between two units (G0, 17 steps) and lets a paused holder's late step land after its unit was undone (12 steps); writers following `#locks` does not close that (it needs a bound on delay) and is not needed. With E-22's F3 (Percolator's rule) and "a failed run undoes every step" (or Kafka's epoch bump), all-or-nothing, no G0 and "every unit ends" hold on seven bounds, each explored in full, up to 2.9 million states: 38 rules by ablation, 1 of them novel (the threshold is 3), 41 of 44 non-equivalent mutants caught. RAMP-Fast keeps read atomicity for plain writes with 1 novel rule (the threshold is 2; 19 rules, 20 of 20 mutants; one read round, or two for 8 to 12% of reads), but for fero's operations real Elle finds fractured reads (10 in 36,000 reads), and the fix needs at least 3 novel rules and has no fixed bound on rounds. Moves: X `saga` (every row but PD and ISR) up on P-15's MUST and unchanged on DEV-01 (one novel rule still, a different one: "undo every step" replaces "writers follow `#locks`"); X `ramp` up on P-15's SHOULD for units of plain sets only (1 novel rule, open to every slot row); for units with operations the SHOULD stays unmet by `saga` and by `ramp`, and is priced from `ktxn` or `2pc` (Kafka's `read_committed`, Percolator).
