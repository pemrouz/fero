# E-47: the `memory` rung inside Raft, on TiKV's shape

**Question (Q-47).** TiKV's shape with the `memory` rung answers a write once a majority of its Raft group holds it in memory, before any disk has it. If a majority of that group then stops uncleanly, the tail it answered but never synced is gone. Q-47 asks two things.
- **Which promises break then?** The candidates: all-or-none transactions (P-15), locks (P-10), exactly once per transaction id (F-02), answered writes on `persisted` groups, and snapshot reads that never go back.
- **Which rules fix them?** The candidates: R1, no transaction spans rungs. R2 (RR-14), no locks, fences or transaction state on a `memory` group. R3 (RR-12, RR-13), a new epoch after an unclean majority loss, with the fence tables restarted. R4, a bounded background fsync.

This is the safety model that VERDICT section 9 step 2b owes (K-09; RR-11 to RR-14). It runs on TiKV's shape: two-phase commit with Percolator's rules, a timestamp oracle, transaction ids. It does not cover COMP2's sagas and client sessions.

**Threshold.** VERDICT section 9's kill table, row 2b: if the rung "breaks a MUST with no rule that fixes it", the rung goes. So the rung stays only if some set of rules makes every property hold on every bound, and it is priced at that set. A rule counts as needed only if removing it brings a counterexample back (the ablation of DEV-10, the study's rule for counting rules and testing models).

**In short** (model-checked here: every reachable state at small bounds, unless a line says "reasoned"):
- **Both groups `persisted` (the baseline): nothing breaks** on any of 11 bounds (up to 259,807 states), and every program can always finish.
- **Without rules, the `memory` rung breaks every promise the referees named, and three they did not.** Shortest traces:
  - A transaction over a `memory` group and a `persisted` group ends half applied (ATOMIC, 14 steps: RR-11's and family B's trace), or its `persisted` half is rolled back after the client was told "committed" (DURABLE, 15 steps).
  - **New: a transaction inside one `memory` group ends half applied too** (ATOMIC, 11 steps). The client hears "ok" for both prewrites; the cut drops one lock; the client commits anyway.
  - A fence table goes back, and a paused holder's old token writes after a newer token's write was acknowledged (FENCE, 13 steps: RR-12's trace, step for step).
  - A transaction told "aborted" commits later, from a commit still in flight (REFUSED, 13 steps: RR-13's trace in Percolator's terms).
  - **New: two holders hold the lock at once** (HOLDERS, 7 steps; added after a review). A claim that was granted is lost in the tail, so a second holder is granted the lock while the first still holds it. This happens even when tokens come from the timestamp oracle.
  - **New: if lock tokens come from a counter in the lock row, one token is handed out twice** (TOKEN, 7 steps). With oracle tokens this cannot happen.
- **Two rule sets are enough. Each is as small as it can be: every part of it is needed.**
  - **{R2}, RR-14's one rule.** No transaction, lock row or fenced write on a `memory` group. A `memory` resource then takes plain writes only. It has no transactions, and no exactly-once: under TiKV's shape exactly-once comes from transaction ids, which R2 keeps off memory. Its "no lock row" part (R2.claim) is needed for one holder per lease, with oracle tokens too.
  - **{R1s, R3, R2.claim}: keep transactions and fenced writes on `memory` resources, and recover.** R1s: a transaction that touches a `memory` group stays inside that one group. R2.claim: lock rows stay off `memory` groups. R3: after an unclean majority stop the new leader takes a new epoch, and four things follow. Every fence rises to the oracle's current time (R3.fence). A prewrite or commit stamped with an older epoch is refused as "outcome unknown" (R3.stale). So is a reader's resolve (R3.res). And a snapshot read that sees an epoch change starts again (R3.read). Each part is needed: without any one of them a counterexample comes back.
  - **{R1s, R3} alone, the second set before the review, does not hold:** it breaks one holder per lease (HOLDERS, 7 steps).
- **The larger bounds agree.** Both sets hold with two snapshots, three copies of a commit with a crash and two readers, and two paused leases with a second claim. The largest run, a one-group transaction read twice under {R1s, R3, R2.claim}, explored all 4,953,029 states.
- **R1 as worded is not enough.** It still lets a transaction span two `memory` groups, and one of them can lose its half (ATOMIC, 11 and 14 steps). It needs the stronger form R1s.
- **R4 is needed in no set.** It bounds how much is lost, not whether a promise breaks. Even at its tightest (sync before the next append), every hazard but the dedup one stays.
- **E-17's greedy ablation** ends at {R2} in all three orders over whole rules, and at {R1s, R3, R2.claim} when R2's three parts are dropped one at a time.
- **The Raft step under the model was checked by brute force** on three explicit replicas (1 to 6 entries). Two paths lead to the new leader after a majority stop, and the model's one step covers both:
  - an election by vote, if replicas that stopped uncleanly could vote on what they synced (up to 181,314 stop-and-election outcomes: exactly the model's cuts);
  - the operator's recovery, which the settled `memory-rung` unit actually asks for, provided it restarts from the longest log any replica holds (up to 39,144 majority stops: never below the majority-synced point). Restarting from the surviving replica alone cut below that point in up to 1,764 of them.
- **So kill test 2b does not fire on TiKV's shape.** The rung can stay, priced at {R2} (one stated rule, no mechanism; `memory` resources lose transactions, locks, fenced writes and exactly-once) or at {R1s, R3, R2.claim} (they keep transactions, fenced writes and exactly-once; an epoch mechanism with four parts, and transactions in flight across a loss end "unknown").

## Words used here

- **Rung**: what an acknowledgement means for a resource. **`persisted`**: a majority has the write on disk. **`memory`**: a majority holds it in memory; the disks catch up in the background.
- **Unclean stop**: power loss or an operating-system crash. The replica keeps only what it had synced to disk. The model also treats a kill -9 this way, which is cautious: a rung that hands each write to the operating system before it answers keeps it in the page cache through a kill -9, as E-02's `memory` rung does. **The unsynced tail** is what a replica held but had not synced.
- **Majority-synced point (k)**: the longest prefix of the log that two of the three replicas have on disk. **The cut**: the length of the log that the new leader keeps after a majority stops uncleanly.
- **TSO**: the timestamp oracle in TiKV's placement driver (PD). It hands out rising timestamps and never loses one here.
- **Percolator's two-phase commit, as TiKV runs it.** A transaction takes a **start ts**, **prewrites** each key (writes a **lock** on it), takes a **commit ts**, and **commits the primary** key (removes its lock, writes a **commit record**). That one commit decides the transaction. The other keys, the **secondaries**, are committed after. A **rollback record** marks a transaction rolled back, so a late prewrite or commit for it is refused.
- **Resolve**: a reader that finds an old lock whose time to live (TTL) has run out **checks the primary**: if the primary is committed, it commits the secondary at the same ts; if the primary is still locked, it rolls the primary back; then it rolls the secondary back.
- **Snapshot read**: a read at one ts sees exactly the transactions committed at or before that ts.
- **Lock, holder, token, fence**: a lock row (`#locks`) grants a **holder** a lease and a **token**. P-10 allows at most one holder per lease. A protected write carries the token. Each group keeps a **fence table**: the highest token it has seen per lock. It refuses a write with a lower token. A **paused holder** is one whose lease lapsed while it was stopped; it does not know, and may write later with its old token.
- **Epoch** (R3): a counter in a group's state that rises once after an unclean majority stop.
- **Acknowledged (acked)**: the client was told the outcome.
- **K `kern`**: the study's name for judging each command inside the group's own state machine, when the command is applied.
- **AG EF**: the liveness check E-14 uses: from every reachable state, some path with no more faults ends every program.

## Method

One exhaustive model in plain Python, [models/memrung.py](models/memrung.py), on E-16's engine ([../E16-controller-loop/engine/engine.py](../E16-controller-loop/engine/engine.py)), which uses E-17's rule language (`harness/dsl.py`) unchanged, as E-20 and E-24 do. Each run explores every reachable state breadth first, so every trace below is a shortest one. Liveness is AG EF. [run47.py](run47.py) runs every configuration; [tools/raftcheck.py](tools/raftcheck.py) checks the Raft abstraction.

**The world (not counted).**
- **Two Raft groups of three replicas, A and B, and a TSO.** Only group A can be hit by the fault: a majority of its replicas stops uncleanly, once per run. Group B never stops, so it needs no replicas in the model.
- **Group A** is kept as the leader's log, the majority-synced point k and, for `persisted`, the commit point (equal to k: a write commits only when two disks have it). For `memory` every appended entry is committed at once, and `sync` (a background step) moves k to the end of the log.
- **The unclean stop of a majority, the restarts and the new leader are one step.** The new leader's log is the old log cut to any length l with k ≤ l ≤ len, plus a no-op of the new term. Two paths lead there.
  - *An election by vote.* A stopped replica keeps its synced prefix. If it could vote on that prefix, a candidate would win only with votes from replicas whose logs are no longer than its own. So the new log is at least the second-longest synced prefix (k) and at most the old log.
  - *The operator's recovery.* The settled `memory-rung` unit forbids that vote: a replica that stopped uncleanly comes back as new and never votes under its old identity. So after a majority stop the group has no voting majority, and it waits for `fero recover --unclean`. That path stays inside [k, len] only if the recovery restarts from the longest log any replica holds: a stopped replica's synced prefix or a survivor's whole log (MEMORY.md's rule 15). Restarting from the survivor alone can cut below k.
  - [tools/raftcheck.py](tools/raftcheck.py) checks both paths on three explicit replicas (section 4). The model treats the recovery as instant; the operator's wait, and the controller setting the new members, are not modelled.
- **The state machine is Percolator, judged when a command is applied** (K `kern`). Commands: prewrite, commit, check-the-primary, resolve, claim the lock, protected write. A claim's token is the TSO time when the leader appends it (the claim's commit ts). A variant takes the token from a counter in the lock row (`-row` bounds).
- **The network.** A command is a copy in flight until a leader appends it: after any delay, in any order, at most once. A client reads its answer from the committed log. If the command is gone (no copy in flight, no entry in the log, as after a cut) it sends it again.
- **Configs.** PP: both groups `persisted`. MP: A `memory`, B `persisted`. MM: both `memory` (only A loses its tail).

**The programs.**
- **A transaction coordinator**: start ts; prewrite every key; commit ts; commit the primary. On "ok" it is told committed; then it sends the secondaries' commits and stops without waiting. A failed prewrite or refused commit tells it "aborted"; a commit refused as stale (R3) tells it "unknown". It may crash at any point.
- **A reader**: takes a snapshot ts and reads each key. A lock of a transaction that started at or before the snapshot blocks it; once that lock's TTL runs out (`expire`, a time step) it checks the primary and resolves the key.
- **Two lock holders**: claim, then one protected write. A holder's lease may lapse while it is paused (`lapse`, a fault), so the other holder can claim over it. The model has no release and no other expiry, so a lease stays live until it lapses.

**The rules** (each a switch; the ablation turns them off):

| Rule | What the model does | Source |
|---|---|---|
| R1 | a transaction whose keys are on groups of different rungs is refused | the task; RR-11's and family B's closer |
| R1s | a transaction that touches a `memory` group and more than one group is refused | found here (R1 as worded is not enough) |
| R2.txn | a transaction with a key on a `memory` group is refused | RR-14 |
| R2.claim | a lock row on a `memory` group is refused | RR-14 |
| R2.put | a protected (fenced) write to a `memory` group is refused | RR-14 |
| R3.fence | the first leader after an unclean majority stop appends an epoch entry, which raises every fence to the TSO's current time | RR-12; OPS-07's rule for a restore |
| R3.stale | a prewrite or a commit stamped with an older epoch (the one the transaction began in) is refused, answer "stale" (outcome unknown) | RR-13; A-08 and E-33's session generation |
| R3.res | a reader's resolve stamped with an older epoch (the one it saw when it sent it) is refused; the reader decides again | found here |
| R3.read | a read returns its group's epoch; a snapshot that sees an epoch change between two reads starts again | found here |
| R4 | the leader appends to a `memory` group only while fewer than W entries (W = 2; W = 1 in section 3.5) are not yet on a majority's disks | the task |

A refused begin, claim or write ends that program at once: the app is told the call is not offered on that resource.

**Properties.** Bugs:
- **ATOMIC**: a reader's snapshot holds some of a transaction's writes and not all (P-15).
- **DURABLE**: an acknowledged write on a `persisted` group is gone: an acked entry missing from its log, or a rollback record for a transaction told committed.
- **MONO**: a later snapshot holds an older value of a key on a `persisted` group.
- **REFUSED**: a transaction told "aborted" has a commit record (F-02).
- **ONCE**: a key holds two commit records of one transaction (F-02).
- **TOKEN**: one token is granted twice (P-10).
- **FENCE**: a group commits a protected write under token t after it acknowledged one under a higher token (P-10; RR-12's trace).
- **HOLDERS**: two holders have each been told "granted", and neither lease has lapsed (P-10: "at most one holder per lease by the writer's time"). Added after the review.
- **done**: the liveness goal: every program can end once faults stop.

Allowed by the rung's contract, reported in separate runs and never counted: **LOST**, an acknowledged write on a `memory` group is gone; **READBACK**, a later snapshot holds an older value of a key on a `memory` group.

**Bounds** (each run: at most one unclean majority stop of group A).

| Bound | What runs | Other faults |
|---|---|---|
| `txn` | one transaction over key a (group A, primary) and key b (group B); one reader, two snapshots | one coordinator crash; lock TTLs run out |
| `txnb` | the same, primary b | the same |
| `txn1` | one transaction over keys a (primary) and c, both in group A; one reader, one snapshot | the same |
| `txn1-2r` | `txn1` with two snapshots | the same |
| `dedup` | one transaction on key x in group A; the commit may be sent twice before any answer; one reader resolves | lock TTLs run out |
| `lockAA` | the lock row and key x both in group A; two holders | one paused lease |
| `lockBA` | the lock row in B, key x in A | one paused lease |
| `lockAB` | the lock row in A, key x in B | one paused lease |
| `…-row` | the three lock bounds with counter tokens; a fenced holder claims once more | one paused lease |
| larger (section 3.7) | `dedup-v`: three copies of the commit, a coordinator crash, two readers; `lockAA-v`, `lockBA-v`: two paused leases and a second claim | |

## Results

Machine: 4 vCPU, 15 GB, Python 3.13.17, every run under the study's heavy lock and `nice -n 10`. Every run below is complete (every reachable state explored) unless it says LIMIT. After the review, the HOLDERS property was added and every run was made again on the final model (603 runs, 40.6 million states, 2,548 s of CPU; the cache now keys each run by a hash of the model). HOLDERS reads the state and adds none, so every run explored in full has the same state count as before. Raw output with every trace: [results/base.txt](results/base.txt) (runs 1 to 4), [results/info.txt](results/info.txt), [results/rules.txt](results/rules.txt), [results/sets.txt](results/sets.txt), [results/subs.txt](results/subs.txt), [results/greedy.txt](results/greedy.txt), [results/w1.txt](results/w1.txt), [results/row.txt](results/row.txt), [results/verify.txt](results/verify.txt), [results/raftcheck.txt](results/raftcheck.txt); every run's numbers in [results/runs.json](results/runs.json) and as tables in [results/summary.md](results/summary.md).

A run that only looks for a counterexample stops at the first one, the shortest. So where HOLDERS (7 steps) and FENCE (13 steps) both break on `lockAA`, the tables of section 3 show HOLDERS only; `lockBA`, whose lock row is on the group that never stops, still shows FENCE.

### 1. Without rules (runs 1 to 4)

Each cell lists every property broken, with the length of its shortest trace (these runs explore everything, not only up to the first break). "ok" means nothing breaks and no state is stuck.

| Run | Config | `txn` | `txnb` | `txn1` | `dedup` | `lockAA` | `lockBA` | `lockAB` |
|---|---|---|---|---|---|---|---|---|
| 1 | PP | ok (65,575) | ok (40,981) | ok (52,713; two snapshots: 259,807) | ok (5,130) | ok (7,049) | ok (1,795) | ok (3,217) |
| 2 | MP, all on the `memory` group | | | ATOMIC 11, REFUSED 17 (452,525) | REFUSED 13 (13,729) | FENCE 13, HOLDERS 7 (32,111) | | |
| 3 | MP, across rungs | ATOMIC 14, DURABLE 15, REFUSED 17 (350,895) | ATOMIC 11 (106,530) | | | | | |
| 3b | MM, across two `memory` groups | ATOMIC 14, REFUSED 17 (350,895) | ATOMIC 11 (106,530) | | | | | |
| 4 | MP, locks and dedup | | | | REFUSED 13 (13,729) | FENCE 13, HOLDERS 7 (32,111) | FENCE 13 (2,591) | HOLDERS 7 (10,629) |

With counter tokens (run 4, `-row` bounds): `lockAA-row` FENCE 13, HOLDERS 7 and TOKEN 7 (26,467 states); `lockBA-row` FENCE 13 (2,645); `lockAB-row` HOLDERS 7 and TOKEN 7 (7,813). All three are ok under PP. No run has a stuck state. ONCE and MONO never break in any run. ONCE cannot (reasoned): a commit record is keyed by the transaction's start ts, so a second commit of the same transaction finds the first. MONO is about `persisted` keys, and a `persisted` group never loses a committed entry (section 4).

**The traces, shortened** (full ones in [results/base.txt](results/base.txt)):

- **Across rungs, primary on the `memory` group (ATOMIC, 14 steps; RR-11's trace).** T prewrites a (A, `memory`) and b (B, `persisted`); both answer ok. T commits a; A commits it in memory; T is told committed. A majority of A stops uncleanly before any disk has the two entries; the new leader keeps none. T sends b's commit; B commits it. A reader sees a's old value and b's new one.
- **Across rungs, the `persisted` half rolled back (DURABLE, 15 steps).** a's lock TTL runs out; a reader checks the primary a and rolls it back; on that answer it sends "roll back b". A stops uncleanly; the new leader keeps a's lock but not the rollback. T's commit of a now succeeds, and T is told committed. Then the reader's "roll back b" lands on B. B, which never lost anything, has rolled back half of a transaction told committed.
- **Across rungs, primary on the `persisted` group (ATOMIC, 11 steps).** a's prewrite (A, `memory`) answers ok; A stops uncleanly and the lock is gone. T prewrites and commits b; a has no lock left to commit, so a reader sees b's new value and a's old one.
- **Inside one `memory` group (ATOMIC, 11 steps; not foreseen).** T prewrites a and c in group A; both answer ok. A stops uncleanly; the new leader keeps a's lock and not c's. T commits a (its lock is there). A reader sees a's new value and c's old one. Within one group a cut is a suffix of the log, but the client acts on answers it got before the cut.
- **A refusal lost (REFUSED, 13 steps; RR-13's trace).** T's lock TTL runs out. T sends its commit twice (a timeout). A reader rolls T back. T's first commit copy lands: "rolled back", and T is told aborted. A stops uncleanly; the new leader keeps T's lock but not the rollback. T's second commit copy lands and commits T.
- **A fence goes back (FENCE, 13 steps; RR-12's trace).** h0 claims (token 2); its lease lapses while it is paused. h1 claims over it (token 4), writes x with token 4, and is told ok. A stops uncleanly; the new leader keeps none of it, so A's fence table is back at 0. h0 wakes and writes x with token 2: A accepts it.
- **Two holders at once (HOLDERS, 7 steps; added after the review).** h0 and h1 both send a claim. A appends h0's claim, and h0 hears "granted, token 3". A stops uncleanly before any disk has the claim; the new leader keeps nothing. A appends h1's claim, and h1 hears "granted, token 4". Neither lease has lapsed, so two holders hold the lock at once.
- **A token handed out twice (TOKEN, 7 steps; counter tokens only).** The same path, but the row's counter is back at 0 after the cut, so h1 gets token 1 again. With oracle tokens h1 gets a later time, which no earlier holder has.
- **`lockAB`** (the lock row on the `memory` group, key x on the `persisted` one, oracle tokens) **keeps fencing but not one holder.** FENCE never breaks there: every claim after the cut has a later oracle time, and x's fence table is on a group that keeps it (reasoned from the model's rules). But HOLDERS breaks in 7 steps. So fencing rests on the fence table, and one holder per lease (P-10) rests on the lock row. Before the review this bound was reported "ok", and the claim that the lock row is not needed with oracle tokens rested on reading P-10 as fencing only.

### 2. What the rung's contract allows (reported, not counted)

The losses the `memory` rung allows by its contract show up wherever a promise lives on group A ([results/info.txt](results/info.txt)). Without rules: an acked prewrite or claim gone (LOST, 4 steps; 7 on `lockBA`, where the first thing acked on A is a protected write), and a later snapshot older than an earlier one on a key in A (READBACK, 13 steps on `txn1-2r`, 16 on `txn` and `txnb`). Under {R1s, R3, R2.claim} both still happen (LOST 4 on `txn1` and `dedup`, 7 on `lockBA`; READBACK 16 on `txn1-2r`, a partial run that stopped at 3 million states): that rule set keeps every promise but not every acknowledged write, which is the contract. Under {R2} neither can happen in these bounds, because nothing that is modelled may sit on the `memory` group. Plain writes, the only thing R2 leaves there, are not in the model.

### 3. The rules (run 5)

#### 3.1 All four together, then each one removed

| Rule set | MP | MM |
|---|---|---|
| R1+R2+R3+R4 | ok on all 7 bounds | ok on all 7 bounds |
| without R1 | ok | ok |
| without R2 | `lockAA`, `lockAB` HOLDERS 7 | `txn` ATOMIC 14, `txnb` ATOMIC 11, `lockAA`, `lockAB` HOLDERS 7 |
| without R3 | ok | ok |
| without R4 | ok | ok |

So with all four on, only R2 is needed, for two reasons. R1 as worded lets a transaction span two `memory` groups (the MM column). The trace is the across-rungs one above, with B in `memory` too: R1 sees one rung and lets it through, and R3 cannot help, because the half that is lost and the half that is kept are in different groups. And only R2's lock-row part stops a lost claim from granting the lock twice (HOLDERS, both columns): R3 raises fences, but it cannot take back a "granted" the first holder already heard.

#### 3.2 Each rule set on its own

| Rule set | breaks (MP and MM, 7 bounds each) |
|---|---|
| none | every bound, in both configs |
| R1 | MP: `txn1`, `dedup`, `lockAA`, `lockBA`, `lockAB`; MM: those and `txn`, `txnb` |
| **R2** | **nothing** (MP: 96, 96, 36, 18, 12, 363, 12 states; the refusals end the programs at once) |
| R3 | `txn` ATOMIC 14, `txnb` ATOMIC 11, `lockAA` and `lockAB` HOLDERS 7, in both configs |
| R4 (W = 2) | every bound, in both configs |
| R1+R3 | MP: `lockAA`, `lockAB` HOLDERS 7; MM: those and `txn` ATOMIC 14, `txnb` ATOMIC 11 |
| R1s | `txn1` ATOMIC 11, `dedup` REFUSED 13, `lockBA` FENCE 13, `lockAA` and `lockAB` HOLDERS 7, in both configs |
| R1s+R3 | `lockAA` and `lockAB` HOLDERS 7, in both configs |
| **R1s+R3+R2.claim** | **nothing** (MP: `txn1` 757,957 states, `dedup` 17,814, `lockBA` 5,947; `txn` and `txnb` 272, refused by R1s; `lockAA` and `lockAB` 12, refused by R2.claim) |
| R1+R2 | nothing |

#### 3.3 Which parts are needed

Each part dropped from the two sets that hold ([results/subs.txt](results/subs.txt)):

| Set, part dropped | breaks | so the part is |
|---|---|---|
| R2, without R2.txn | `txn` ATOMIC 14, `txnb` ATOMIC 11, `txn1` ATOMIC 11, `dedup` REFUSED 13 (MP and MM) | needed |
| R2, without R2.claim | `lockAA`, `lockAB` HOLDERS 7 (MP and MM) | needed, with oracle tokens too (before the review: "not needed") |
| R2, without R2.put | MP `lockBA` FENCE 13 | needed |
| R1s+R3+R2.claim, without R1s | `txn` ATOMIC 14, `txnb` ATOMIC 11 (MP and MM) | needed |
| R1s+R3+R2.claim, without R3.fence | MP `lockBA` FENCE 13 | needed |
| R1s+R3+R2.claim, without R3.stale | `txn1` ATOMIC 11, `dedup` REFUSED 13 (MP and MM) | needed |
| R1s+R3+R2.claim, without R3.res | `txn1` ATOMIC 16 (MP and MM) | needed |
| R1s+R3+R2.claim, without R3.read | `txn1` ATOMIC 11 (MP and MM) | needed |
| R1s+R3+R2.claim, without R2.claim | `lockAA`, `lockAB` HOLDERS 7 (MP and MM) | needed |

With R2.claim in the set, R3.fence is tested only where the lock row sits on the group that never stops (MP `lockBA` here; `lockBA-v` in 3.7). In MM that bound is refused too.

R3.read's trace (11 steps): T prewrites a and c in A and commits a. A reader takes a snapshot and reads a: T's value. A stops uncleanly and loses all three entries. The reader reads c: the old value. Every write of T is gone (an allowed loss), but this one snapshot holds half of T. With R3.read the reader sees A's epoch change between its two reads and starts again.

R3.res's trace (16 steps): T prewrites c and a in group A and commits a. A reader finds c's lock expired, checks the primary a, hears "committed at ts 2", and sends "commit c at ts 2". A stops uncleanly; the new leader keeps only c's lock, so a's commit and lock are gone. The reader's resolve lands and commits c. A snapshot holds c's new value and a's old one. The DURABLE trace in section 1 is the same path across two groups. So a stamp on the coordinator's own commands is not enough: a decision a reader made before the cut must not land after it.

#### 3.4 E-17's greedy ablation

Start from every rule, drop each rule in turn, keep it if a counterexample comes back, then check that each rule left is needed ([results/greedy.txt](results/greedy.txt)). The first three orders treat R2 as one rule; the fourth drops its three parts one at a time.

| Order | Ends at | Final check |
|---|---|---|
| R1, R1s, R2, R3, R4 | {R2} | R2 needed (MP `txn` ATOMIC 14 without it) |
| R4, R3, R2, R1s, R1 | {R2} | the same |
| R2, R1, R1s, R3, R4 | {R2} | the same (dropping R2 first breaks MP `lockAA`, HOLDERS 7) |
| R2.txn, R2.put, R1, R1s, R2.claim, R3, R4 | {R1s, R2.claim, R3} | R1s needed (MP `txn` ATOMIC 14); R2.claim needed (MP `lockAA` HOLDERS 7); R3 needed (MP `txn1` ATOMIC 11) |

Both sets are 1-minimal. Neither contains R1 or R4. Before the review the third order ended at {R1s, R3}; HOLDERS now keeps R2 in it.

#### 3.5 R4: a bounded fsync bounds the loss, not the harm

At W = 2, R4 alone breaks every bound (3.2). At W = 1 (the leader syncs before every append, which is `persisted` with one entry in flight), only `dedup` holds ([results/w1.txt](results/w1.txt)). In MP: `txn` DURABLE 17, `txnb` ATOMIC 11, `txn1` ATOMIC 13, `lockAA` and `lockAB` HOLDERS 8, `lockBA` FENCE 14 (MM the same, but `txn` ATOMIC 18). Why, reasoned from the traces: in `dedup` the "aborted" answer comes from an entry appended after the rollback record, so at W = 1 the rollback is already on disk. In the others the harm sits in the acknowledged entry itself (a claim, a fence raise, a lock, a commit record), and R4 always lets the last entry be lost. A real bound would be in time (say a second), which is far more than one entry at any useful write rate (reasoned).

#### 3.6 Lock tokens from a counter in the row

With counter tokens ([results/row.txt](results/row.txt)): no rules breaks all three lock bounds (HOLDERS 7 and TOKEN 7 on `lockAA-row` and `lockAB-row`, FENCE 13 on `lockBA-row`). {R2} holds. {R2} without R2.claim, and {R1s, R3}, break `lockAA-row` and `lockAB-row` (HOLDERS 7, TOKEN 7): R3 raises fences but cannot stop the row reissuing a token it lost. {R1s, R3, R2.claim} holds. So the lock row must stay off `memory` groups with either kind of token; counter tokens add TOKEN to the reasons.

**Oracle tokens are a design rule, not a given.** Real TiKV takes a row's version from its commit timestamp, which comes from the oracle (from TiKV's design, not checked here). But the judged TiKV-TS row does not say so. Its positions are hybrid-logical-clock times (O `hlc`), and its `lock-rows` unit takes the token from the row's own version, reading slot epochs and sequences, not the oracle. If a version came from a leader's clock, a new leader on a lagging clock could hand out a time at or below one lost in the tail; then a token, or a cursor time, could repeat. So "every token and every version on a `memory` resource is an oracle time" has to be stated as a rule (MEMORY.md rule 4). The sweep uses oracle tokens.

#### 3.7 Larger bounds

The sets that hold, on the larger bounds, with a state limit of 6 million ([results/verify.txt](results/verify.txt)). Every run is complete.

| Rule set | Config | `txn1-2r` | `dedup-v` | `lockAA-v` | `lockBA-v` |
|---|---|---|---|---|---|
| {R2} | MP and MM | ok (96) | ok (78) | ok (12) | ok (387 MP, 12 MM) |
| {R1s, R3, R2.claim} | MP and MM | ok (4,953,029) | ok (1,672,744) | ok (12) | ok (61,833 MP, 12 MM) |
| R1+R2+R3+R4 | MP and MM | ok (396) | ok (222) | ok (12) | ok (1,283 MP, 12 MM) |
| no rules | MP | ATOMIC 11 | REFUSED 13 | HOLDERS 7 | FENCE 13 |
| no rules | PP | ok (259,807) | ok (378,025) | ok (9,417) | ok (2,883) |

With R2.claim in the set, `lockAA-v` is refused at once; `lockBA-v`, with its lock row on the group that never stops, is where R3.fence meets two paused leases and a second claim. The `txn1-2r` run under {R1s, R3, R2.claim} took 391 s; it is the largest run here (its memory was not measured: at the 1.2 KB a state measured on a 757,957-state run, about 6 GB).

### 4. The Raft abstraction, checked by brute force

[tools/raftcheck.py](tools/raftcheck.py) builds three explicit replicas, each with its own log length, sync point and up flag. The leader appends; a follower takes one more entry; a replica syncs one more entry. The commit point is the second-largest log in memory (`memory`) or on disk (`persisted`). From every reachable state it tries every unclean stop of two or three replicas, then the two paths to a new leader ([results/raftcheck.txt](results/raftcheck.txt)).

**Elections by vote.** Every election Raft allows, if replicas that stopped uncleanly could vote on their synced prefix: a candidate and a set of at least two voters whose logs are no longer than its own. This includes the restarted followers electing one of themselves while the old leader is alive.

| Rung | Entries | States | Stop and election outcomes | Cut below k | (len, k) pairs where the cuts differ from [k, len] | Elections with no stopped voter | Acked entry lost |
|---|---|---|---|---|---|---|---|
| `persisted` | 1 to 6 | 19 to 9,786 | 483 to 181,314 | 0 | 0 of 3 to 28 | 0 | 0 |
| `memory` | 1 to 6 | 19 to 9,786 | 483 to 181,314 | 0 | 0 of 3 to 28 | 0 | 95 to 76,482 |

So on this path the model's single step (cut to any l in [k, len]) adds no cut Raft cannot make and misses none. `persisted` never loses an acked entry; `memory` does. Every such election has at least one voter that stopped uncleanly, so the trigger "a leader elected with any voter that restarted uncleanly takes a new epoch" would fire after every majority stop.

**The operator's recovery** (`memory` only; added after the review). The settled `memory-rung` unit forbids the vote above: a replica that stopped uncleanly comes back as new and never votes under its old identity. Under `persisted` that rule does not apply, since such a replica still holds all it acknowledged.

| Entries | Majority stops | Stops that leave a voting majority | Rule 15 (longest log any replica holds): cut below k / outside [k, len] | Rule 15 with one stopped replica's disk lost: cut below k | Restart from the survivor: stops with a survivor / cut below k |
|---|---|---|---|---|---|
| 1 | 76 | 0 | 0 / 0 | 0 | 57 / 2 |
| 2 | 508 | 0 | 0 / 0 | 0 | 381 / 18 |
| 3 | 2,108 | 0 | 0 / 0 | 0 | 1,581 / 84 |
| 4 | 6,608 | 0 | 0 / 0 | 0 | 4,956 / 280 |
| 5 | 17,192 | 0 | 0 / 0 | 0 | 12,894 / 756 |
| 6 | 39,144 | 0 | 0 / 0 | 0 | 29,358 / 1,764 |

- No majority stop leaves a voting majority, so every one waits for `fero recover --unclean`.
- If the recovery restarts from the longest log any replica holds (a stopped replica's synced prefix or a survivor's whole log), the cut stays inside [k, len], so the model's step covers it. That holds even with one stopped replica's disk unreadable.
- If it restarts from the surviving replica alone, the cut falls below k: an entry that two disks had is lost. The shortest case: the leader and follower 1 sync an entry, follower 2 has not received it, and the leader and follower 1 lose power.
- So R3's trigger in the model ("after every majority stop") matches the recovery path: every majority stop goes through the operator.

## What it costs, by rule set (reasoned)

- **{R2}.** One stated rule and no mechanism, as RR-14 said. A `memory` resource offers plain writes only: no transactions, no lock rows, no fenced writes.
  - **No exactly-once on `memory`.** Under TiKV's shape a retried write is matched to its first try by its transaction id. R2.txn refuses even a one-key transaction (without R2.txn, `dedup` breaks: REFUSED 13). So a plain write on a `memory` resource carries no id, and a write resent after a timeout may apply twice.
  - A caller id kept with the write would prevent that, with MEMORY.md's rule 12 refusing older copies after a recovery. So might a one-key write that keeps its transaction id and commits in one step (TiKV's one-phase commit, which leaves no lock for a reader to resolve). Neither is modelled here.
  - The `memory` rung then fits caches, counters you can lose, and streams you can replay. Everything that needs P-10, P-15 or F-02 sits on `persisted` resources.
- **{R1s, R3, R2.claim}.** Keeps transactions (inside one group), fenced writes and exactly-once on `memory` resources. Lock rows stay on `persisted` groups. The price:
  - R3 is one mechanism, an epoch entry, with four needed parts: the fence floor from the TSO, epoch stamps on a transaction's prewrites and commits, epoch stamps on readers' resolves, and the epoch check on reads. TiKV already carries a region epoch on every request and refuses a stale one, but there the client retries with the new epoch (from TiKV's design, not checked here). R3.stale needs the opposite: for a transaction begun before the cut, the refusal is final ("unknown"). R3.res and R3.read have no counterpart we know of. Whether these count as novel is for DEV-10's counters; this run did not count them guard by guard.
  - After every unclean majority stop, transactions in flight end "unknown", fenced writers must claim again, and snapshot reads in flight start again.
  - R1s ties a transaction to one group. Under P `split+merge` a range can split under a transaction. Then R1s becomes either "refused if its keys are in two ranges when it prewrites", which an app cannot predict, or "a `memory` resource never splits", which caps its size. Neither is modelled.
  - A replica must mark an unclean restart on disk, and Raft's term and vote must be synced (they change only at elections, so this costs nothing on the write path).
- **Either set needs the recovery to restart from the longest log any replica holds** (section 4). Restarting from the survivor alone cuts below k, which no rule here repairs.
- **The loss itself stays.** Under either set an acknowledged write on a `memory` resource can vanish after a majority stops uncleanly (section 2). That is the rung's contract, and the rules keep it from breaking any other promise that was modelled.

## Where MIN-P+par differs

MIN-P+par (3 / 6 / 264) has no `memory` rung, so none of these hazards arise there: every ack is `persisted`. Adding the rung to it gives COMP2's shape. COMP2's sagas (X `saga`), client sessions (D `sess`) and slot fences are not modelled here. E-24's saga and lock bounds and E-20's dedup bounds with a lost tail are still owed for it, as VERDICT 9 step 2b says. Reasoned from the traces here:
- The FENCE trace is the same mechanism under any shape: a fence table in a lost tail. COMP2 needs R2.put or R3.fence just as TiKV's shape does.
- The HOLDERS trace is the same too: a claim in a lost tail. COMP2 keeps `#locks` on a `persisted` group (API.md), which is R2.claim.
- The REFUSED trace has a session form: a refusal or a session floor in the lost tail (RR-13). R3.stale's counterpart there is a new session generation for the group's slots (A-08, E-33).
- A saga's steps are visible one at a time anyway (COMP2's P-15 S is not met), so R3.read has no saga counterpart. The half-a-unit trace (RR-11) needs R2's refusal or a per-group rule like R1s. COMP2 sets its rung per resource (footnote 13), so RR-14's refusal is the closer open to it.
- The recovery rule of section 4 holds for COMP2's Raft groups too: the same groups, the same lost tail.

## What the model leaves out

- **One unclean stop per run, of group A only.** A second loss before the first heals (a replica holding a divergent log that could win a later election) is not modelled. Group B never stops.
- **Raft's term and vote are assumed synced.** If they too sat in memory, a restarted replica could vote twice in one term; that is a different hazard.
- **The recovery is one instant step.** raftcheck shows which cuts it may make. The operator's wait, the controller setting the new members and key range, and the removal of replicas left over from the old group are not modelled.
- **R3's trigger is modelled as "after every majority stop".** raftcheck shows every majority stop goes through the operator's recovery, so the real trigger is that recovery.
- **Splits and merges** (P `split+merge`), slot or range moves, leader leases for reads, and the old leader serving reads after its followers restart.
- **Percolator only.** TiKV's async commit and one-phase commit, pessimistic locks, garbage collection of versions and of rollback records, and lock TTLs by clocks are left out.
- **Plain (raw) writes on a `memory` group**, the only thing R2 leaves there, with their ops, conditions and retries.
- **Small bounds.** One transaction of two keys, one or two readers, two lock holders, at most two paused leases, one crash. No two transactions conflict.
- **Counting.** Rules are counted at the level of R1 to R4 and their parts, and each part's need is shown by an ablation. DEV-10's guard-by-guard count and mutants (one-rule bugs planted to test the model) were not made. One agent ran this; DEV-10 (e) asks for a second.

## Against the threshold

The threshold: if the rung "breaks a MUST with no rule that fixes it", the rung goes (kill table row 2b). Without rules it breaks P-15 (ATOMIC, DURABLE), P-10 (FENCE, HOLDERS, and TOKEN with counter tokens) and F-02 (REFUSED). But two rule sets fix every one of them on every bound, with every program still able to finish. So the rung passes 2b on TiKV's shape at these bounds:
- **The cheap way: {R2}** (RR-14's one rule, all three parts needed). It costs `memory` resources their transactions, locks, fenced writes and exactly-once.
- **The rich way: {R1s, R3, R2.claim}.** It keeps transactions, fenced writes and exactly-once, for an epoch mechanism with four needed parts and "unknown" answers after a loss. Locks stay off `memory`.
- **Not enough on their own:** R1 as worded (two `memory` groups), R3 alone (transactions across rungs; two holders), {R1s, R3} (two holders), R4 at any window.
- **Either way** the operator's recovery must restart from the longest log any replica holds.

## How to rerun

```sh
./run.sh                 # everything, in order (603 runs, about 42 minutes of CPU on one core)
./run.sh raft            # the brute-force check of the Raft abstraction and of the recovery (about 1 s)
./run.sh base info       # runs 1 to 4 and the allowed losses
./run.sh rules sets subs w1 greedy row verify   # run 5
HEAVY= ./run.sh base     # without the study's lock wrapper (run.sh also falls back by itself when it is missing)
python3 ../E16-controller-loop/engine/cli.py models/memrung.py MP --bound lockAA      # one run, with its trace
python3 ../E16-controller-loop/engine/cli.py models/memrung.py MP-R1s+R3 --bound txn1 --drop R3.read
```

The cache, [results/runs.json](results/runs.json), keys each run by a hash of `models/memrung.py` and the bound's settings. A changed model therefore runs afresh instead of reading an old result. If a step fails for any reason other than its 28-minute limit, `run.sh` prints the exit status and stops without rebuilding `results/summary.md`.

## Files

- [models/memrung.py](models/memrung.py): the model (world, Percolator state machine, programs, rules, properties, bounds).
- [run47.py](run47.py): every run, cached in [results/runs.json](results/runs.json), text with traces in `results/<step>.txt`. [report47.py](report47.py): [results/summary.md](results/summary.md) from the cache.
- [tools/raftcheck.py](tools/raftcheck.py): the brute-force check of the Raft abstraction and of the operator's recovery. [run.sh](run.sh): every step. [fetch.sh](fetch.sh): checks the engine is there (nothing is downloaded).

**Q-47.** On TiKV's shape the `memory` rung, with no rules, breaks three MUSTs.
- P-15: a transaction ends half applied, across rungs and inside one group.
- P-10: a fence table goes back, two holders get the lock at once, and a counter token is reissued.
- F-02: a refused transaction commits.

Two 1-minimal rule sets fix all of it, at these bounds and on larger ones (up to 4,953,029 states). One is {R2}, RR-14's refusal. The other is {R1s, R3, R2.claim}: one group per `memory` transaction, lock rows off `memory`, and an epoch after an unclean loss with four needed parts. R1 as worded and R4 are not enough, and neither is needed. The model's recovery step is sound only if `fero recover --unclean` restarts from the longest log any replica holds (checked by brute force).

Moves: kill test 2b does not fire for TiKV's shape. TiKV-TS's P-15 (M and S), and P-10 and F-02 for its `memory` resources, get the model their closers asked for (at these bounds, one agent). R1 is replaced by R1s or R2. R2.claim is needed with oracle tokens too. R4 is dropped as a safety rule.

