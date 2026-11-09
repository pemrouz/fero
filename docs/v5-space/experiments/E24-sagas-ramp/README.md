# E-24: sagas with fenced locks, and RAMP

**Question (Q-24).** Do sagas with fenced locks meet P-15's MUST (every unit finishes or is undone, even with paused holders), and can RAMP meet its SHOULD cheaply?

**Threshold.** The saga holds with 3 novel rules or fewer → `saga` is enough for the MUST. RAMP holds read atomicity with 2 novel rules or fewer → P-15's SHOULD is priced at that, and X `ramp` is open to every slot row; otherwise atomic visibility is priced from published designs (Kafka's `read_committed`, Percolator).

@@INSHORT@@

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
- A unit's step i appends the unit's id to the list at its partition (Elle's list-append, the form E-22's P-15 workload writes). An append is "push if absent", so it is idempotent, and its undo removes the id. A re-run of a step that is applied answers its first outcome (dedup by attempt id). A step's condition may fail (budget). The writer judges it against the data when the write arrives, and the data can change between attempts (a budget is topped up), so a step refused for one holder may pass for another holder later, or be refused again.
- Each unit has an original holder (`a`, which never restarts) and a later holder (`b`, the app calling `saga(steps, { id })` again; it restarts after a crash).
- **Faults** (budgets): a crash at any point; a lease that lapses while its holder is alive (the paused holder, who acts later with its old tokens); a step whose condition fails. A crashed or finished holder's lease lapses with time. In the options that follow `#locks`, each writer's view of `#locks` lags by any amount (a calm step brings it up to date).

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
| L1 | AG EF: every unit can end `done` or `undone` once faults stop. It asks every unit to end, not only those begun, so a model that never begins a unit fails. |

**Bounds.**

| Bound | Units | Holders | Crashes | Paused leases | Failed conditions |
|---|---|---|---|---|---|
| `one` | 1 on p, q | a1, b1 | 1 | 1 | 1 |
| `two` | 1 and 2, both on p, q | a1, a2, b1 | 0 | 1 | 0 |
| `sub` | 1 on p, q; 2 on q | a1, a2, b1 | 0 | 1 | 1 |
| `three` | 1 on p, q, r | a1, b1 | 1 | 2 | 1 |
| `one2` (verify) | 1 on p, q | a1, b1 | 2 | 2 | 1 |
| `two-f` (verify) | 1 and 2 on p, q | a1, a2, b1, b2 | 1 | 1 | 1 |
| `sub-f` (verify) | 1 on p, q; 2 on q | a1, a2, b1, b2 | 1 | 1 | 1 |

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

A seeded random simulation, built from the rules the models check: units over 2 or 3 of three partitions, under locks taken in key order and owned by the unit until it ends; a holder may crash between any two steps and a later holder finishes or undoes the unit; a step's condition may fail (then every step is undone, as `fullundo`). Three readers read 2 or 3 partitions per transaction, one partition per step, so writes land between their reads. Two visibility modes: `plain` (each step visible at once: the saga as DESIGN-V5 5.3 builds it) and `ramp` (each step is a RAMP prepare; once every prepare is acked the unit gets a timestamp and commit markers go out one by one; readers do RAMP-Fast's two rounds). 100 histories for each mode at a failure rate of 0 and of 0.15 per step. Each unit is one Elle transaction of appends (`:ok` if it ended done, `:fail` if undone or aborted); each read is one transaction of reads. Real Elle 0.2.8 (`elle.list-append`) checks each history at `:read-committed` (P-15's MUST: no G0, G1a, G1b, G1c, lost or doubled element) and at `:serializable` (which adds G-single, the fractured read).

## Results

### 1. The saga: which designs hold (model-checked here, [results/design-saga.txt](results/design-saga.txt))

| Option | one | two | sub | three | one2 | two-f | sub-f |
|---|---|---|---|---|---|---|---|
| `draft` | A1, 11 steps | A2, 17 steps | A1, 11 steps | A1, 13 steps | A1, 11 steps | A1, 11 steps | not run |
| `owned` | A1, 11 steps | holds | A1, 10 steps | A1, 13 steps | A1, 11 steps | A1, 11 steps | not run |
| `bump` | holds | holds | holds | holds | holds | holds | not run |
| `fullundo` | holds | holds | holds | holds | holds | holds | holds |
| `raise` | holds | holds | holds | holds | holds | holds | not run |
| states (`fullundo`) | 9,310 | 1,858 | 6,831 | 283,698 | 256,407 | 1,582,962 | 801,204 |
| seconds (`fullundo`) | 0.5 | 0.1 | 0.3 | 26.2 | 20.4 | 155.3 | 94.3 |

`bump` explores 10,735 / 2,628 / 7,699 / 285,392 / 279,680 / 2,100,092 states on the same bounds, `raise` 7,538 / 1,858 / 5,935 / 216,043 / 206,918 / 1,348,312. Every run that holds is complete (every reachable state explored); a run that breaks stops at its first, shortest counterexample.

**A note on the model, and when `owned` would be enough.** A step's condition is judged by the partition's writer against the data when the write arrives. That data can change between two attempts at the same step (a budget is topped up), so the model lets a step refused for one holder pass for another later. An earlier version of the model made a refusal final (refused again for every later holder). That rule forbids exactly the paused holder's late step, so it hid the A1 trace below: in that version `draft` broke only A2 and `owned` held on `one`, `two` and `sub` ([results/design-saga-sticky.txt](results/design-saga-sticky.txt), a partial run). So `owned` is enough only for apps whose step conditions never change their answer, which `saga` cannot know. The model also says that a re-run of a step that is applied answers "applied" (dedup by attempt id, the saga id and the step), never a refusal.

**The draft's write cycle (A2, G0), 17 steps: E-22's finding, now exhaustive.** Holder a1 claims p and q and begins unit 1, then pauses (its lease lapses). Holder a2 claims both locks (tokens 2) and begins unit 2; the draft does not look at unit 1. a1, still paused in its own mind, appends 1 at p with token 1: p's writer has not yet followed `#locks` to version 2 and has seen no token for p, so it accepts. a2 appends 2 at p and at q and ends. Later holder b1 (tokens 3) finds unit 1 unfinished and finishes it: 1 goes to q. Now p is [1, 2] and q is [2, 1]: unit 1 is before unit 2 on p and after it on q.

**The paused holder's write after an undo (A1), 11 steps: it breaks both `draft` and `owned`.**
1. a1 claims p and q (tokens 1), and pauses; its lease lapses.
2. b1 (the app retrying the same saga id) claims both (tokens 2) and begins the unit.
3. a1 wakes, reads `#sagas`, finds the unit running, and continues it.
4. b1's step at p is refused by its condition. A refused write commits nothing, so p's writer never sees token 2.
5. a1 appends at p with token 1. p's fence is 0 and p's writer has not yet followed `#locks` to version 2, so it accepts.
6. b1 records `undo`; its failed step was the first, so it has nothing to undo, and it records `undone`.
7. The unit is `undone`, yet its id is in p's list.

The draft's answer to this is "every shard's writer follows `#locks`" (DESIGN-V5 5.3), with the claim that "the holder's lease margin (a round trip plus `skew.max`) covers" the follow lag. In this model the lag is any length, as it is for a paused process: a pause can outlast any margin, and a write can sit in a socket buffer. So **following `#locks` is not enough** without a bound on message delay. It is also **not needed**: `bump`, `fullundo` and `raise` hold on every bound with no following at all. All three make the same thing true: **whoever ends a unit has written every one of its partitions with its own token**, so a paused holder's later write is refused by that partition's own fence table.
- `fullundo` gets it free on the happy path: a forward run writes every partition anyway, and an undo now undoes every step, applied or not.
- `bump` pays one extra write per partition on every saga.
- `raise` needs a kernel change (a refusal that commits a fence record).

@@ABLATION@@

### 2. RAMP-Fast (model-checked here, [results/design-ramp.txt](results/design-ramp.txt))

| Option | two | fol | gc | move | fol-move | gc-move | gc-fol |
|---|---|---|---|---|---|---|---|
| `ramp` | holds | holds | holds | holds | holds | holds | @@GCFOL@@ |
| `noserve` | L, V | L, V | holds | V | L, V | V | @@GCFOL2@@ |

@@RAMPSTATES@@

- **Read atomicity (RA), at most two rounds (R2), monotonic reads (MONO) and KEEP hold** on every bound, with a client crash between prepares and markers, a lagging follower, garbage collection and a slot move (register semantics: a version is its unit's value; see 3 for operations).
- **A crashed client leaves its unit half committed, and a reader can see it.** `noserve` fails L in 4 steps and V in 9: unit 2 prepares at p and q, commits at p, and its client crashes. A reader sees 2 at p and fetches q's pending version 2 in round 2, as RAMP says. But q's lastCommit stays at 0 forever, so the same process's next read of q (which must not go back, fero's read rule) waits forever (L), and any other reader of q alone sees the older value (V: what one reader saw is undone for the next). RAMP's paper leaves completing a failed client's commit to recovery; here, **a round-2 fetch of a pending version commits it at the writer** (two updates: the marker and lastCommit), and every property holds.

@@RAMPABL@@

### 3. Elle (real Elle 0.2.8, [results/elle.md](results/elle.md), [results/elle-sim.txt](results/elle-sim.txt))

| Histories | n | read committed valid (MUST) | serializable valid | anomalies (histories with it: cases) | reads needing a second round |
|---|---|---|---|---|---|
@@ELLETABLE@@

- **The plain saga meets the MUST and not the SHOULD, as expected.** With no failed conditions, every history is valid at read committed: no G0 between units, no lost or doubled element. But readers see units half done (G-single) in nearly every history. With failed conditions, readers also see appends that are later undone (G1a, an aborted read) and lists that lose an element (incompatible order): a saga's undo is visible, which is what "readers can see the intermediate states" means (E-22 saw the same).
- **RAMP-Fast removes almost every fractured read, but not all.** Real Elle found one G-single in 200 RAMP histories ([results/ramp-f00-069.edn](results/ramp-f00-069.edn)). It is real, and it is a property of RAMP-Fast, not of the simulation: unit 9 appended to keys 0 and 1, then unit 6 appended to keys 1 and 2. A reader got key 1 at unit 6's version, whose list is [2, 3, 9, 6]: it includes unit 9's append. RAMP-Fast's metadata on that version names only unit 6's siblings (keys 1 and 2), so the reader never asks for key 0 at unit 9, and it returns key 0 as [3], without 9. RAMP assumes a version is only its writer's value (a register). fero's operations (`push`, `incr`, `merge`, `max`, `min`) make a row's value carry every earlier unit's effect, so the version names more units than its writer. A direct count over 1,000 histories per row ([elle/fractured.py](elle/fractured.py)): @@FRACT@@
- **The fix, `rampv`: each version carries, for each sibling partition, the newest unit it includes that also wrote there** (a small vector, one entry per partition co-written with this one), and the reader repeats round 2 until nothing more is needed. Elle finds nothing in its 200 histories, and the direct count finds no fractured read in 36,000. It costs one more novel mechanism (the vector), and the read is no longer bounded at two rounds: a fetched version can name a newer unit at a third partition (a chain through one partition). None of 36,000 reads needed a third round here, but the bound is the length of such a chain, not 2.



## What the models leave out

- **Raft, elections and slot moves inside a group.** Each group is an abstract linearizable writer; E-14, E-15 and E-17 check those layers. A slot move appears only in the RAMP model, as one atomic step; the saga's fence tables are carried by a move as DESIGN-V5 4.2 says, which E-15 checks.
- **Unclean recovery** (a committed write lost). Under it, a fence table can go back; E-15 and slot_move.py show the recovery rules that keep positions and tokens from repeating.
- **Time.** Leases lapse by a free choice, not by clocks; nothing here depends on a clock bound. That is the point: the model shows which rules are safe with *no* timing assumption. A design that leans on "the lease margin covers the follow lag" is safe only under a timing bound the model does not grant.
- **Operations that are not idempotent** (`incr`, `push` of a value already there). The model's steps are idempotent appends; a real step relies on dedup by attempt id for a re-run, and E-20 and E-30 check dedup and its horizon. A step whose effect cannot be inverted cannot be undone at all (E-22's F4: `saga` refuses such a step).
- **Readers inside the saga model.** The saga's MUST does not speak of readers; readers (and fractured reads) are checked by the RAMP model and by Elle.
- **Saga steps with conditions under RAMP.** The RAMP model has blind writes, as RAMP does. The Elle simulation runs RAMP under the saga's locks, with failed conditions aborting the prepares; it is a simulation, not an exhaustive check.
- **Bounds.** At most two units with two holders each, three partitions, two faults of a kind. The verify bounds add a fault or a unit.

## Files

- [models/saga.py](models/saga.py), [models/ramp.py](models/ramp.py): the models. [run.sh](run.sh): every run below. [fetch.sh](fetch.sh): checks the Elle jars (fetched by E-22b).
- [elle/sim.py](elle/sim.py), [elle/check.clj](elle/check.clj), [elle/summarize.py](elle/summarize.py): the histories, real Elle, the table.
- [results/](results): the design runs with traces (`design-saga.txt`, `design-ramp.txt`), the ablations (`*-ablation.json`), `summary.md` (the rule tables and mutants), `elle.md`, and one history of each mode.
- Machine: Ubuntu 24.04 in a Firecracker VM, 4 vCPU, 15 GB RAM; Python 3.13; OpenJDK with Elle 0.2.8 and Clojure 1.12.0. Every run held `$SP/bin/heavy` (shared) while other agents' jobs ran.

@@VERDICT@@
