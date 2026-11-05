# The slot move, checked by exhaustive search

[slot_move.py](slot_move.py) is a small model checker for the slot move in [DESIGN-V5.md](../DESIGN-V5.md) §4.2 "Moving a slot". It is plain Python 3, standard library only, with no outside tools. It builds every state the model can reach, checks each one, and prints the shortest trace to any state that breaks a property (it searches breadth first, so the first bad state it finds is a nearest one).

Some words used below:
- A **slot** is one of a resource's 1,024 fixed hash buckets. A **shard** is a Raft group that holds some slots. A **move** hands one slot from shard A to shard B (DESIGN-V5 §2).
- The **slot table** is a row per slot in `#meta`, the cluster's own shard, naming the shard that holds the slot.
- An **unclean recovery** (`fero recover --unclean`) rebuilds a shard from one surviving copy after its majority is lost. The copy may lag, so recent entries can be gone. The shard gets a new **incarnation**, and its slots a new **epoch**.

```sh
python3 docs/v5-spec/slot_move.py --jobs 4        # the second round's runs below: about 95 CPU-minutes
python3 docs/v5-spec/slot_move.py --quick         # a smoke test, seconds
python3 docs/v5-spec/slot_move.py --only fixed --bound move   # one run
python3 docs/v5-spec/slot_move.py --list          # the run names and the bounds
```

This file has two rounds. The **second round** checks the revised protocol (the move's owner, the ready report, the slot table, unclean recovery). The **first round**, at the end, checked the protocol before that revision; its findings are fixed in the text.

## Second round: the revised protocol

### The result, first

- **The text as written fails, but only after an unclean recovery.** Without a recovery (`dedup`, `deep`) it holds every property. With one:
  - two shards can hold s (property 1, 20 steps);
  - the table can name a shard that does not hold s (property 9, 15 steps);
  - a position can be handed out twice (property 6, 26 steps).
- **Five fixes make it hold.** Each is one or two sentences, given below with its trace:
  1. A recovered shard that leaves a slot shut ends its part in every move of that slot.
  2. The table row is versioned by the move, the writer's incarnation and the step. On an abort, B always writes `s → A` back.
  3. A recovery that reopens a slot first writes the table row, at the new epoch.
  4. A fence binds the target's incarnation.
  5. After a recovered target's abort, `unfenced` reopens s in the new epoch.

  With all five, every property holds on all six bounds (from 47,457 to 7,510,764 states). From every state without a recovery, every move still finishes or is cancelled. Leaving out any one of the five breaks property 1, 6 or 9.
- **Mutants.** 16 of 18 are caught, including the coordinator's (a), (c), (d) and (e). Two are not caught:
  - (b), asking the other shard before reopening: fix 3 already covers it;
  - B serving after appending `open` but before it commits, as in round 1.

### What the model now has

Everything from the first round carries over: the abstract Raft groups, the client and dedup, and the message set (`git show 28ad0a2:docs/v5-spec/slot_move.md` has the full write-up). Added:

- **The move's owner (C2).** A's leader appends `exporting(s, to B)`. The move's name is that entry's position in A's log. Every message of the move carries the name. Before its fence, A may cancel on its own (`cancel`), and B then drops its copy. After the fence, only B gives up (`abort`, only while its log has no `open`). B writes `s → A` back, then reports the abort, and A reopens s with `unfenced` at N.
- **The ready report (S1).** B commits its bulk copy, then reports ready with the position its copy reached. A fences on that report. After the fence commits, only the delta since the ready position crosses, then `END(N)` and the carried state.
- **The slot table (C1).** `#meta` is a third party: a register that B writes by message, that answers with an ack, and that may be slow (a delayed message). B writes `s → B`, and only once the ack comes does it append `open`.
- **Unclean recovery.** At most once per run, either shard may be recovered:
  - its committed log becomes any prefix of itself (a lagging survivor's copy);
  - its tail and its leader's memory are lost;
  - its epoch goes to 1, and positions compare as (epoch, seq);
  - then the recovery rule decides s: reopen only if the table names this shard, its copy holds s's rows, and no other shard holds s open or is importing it; otherwise s stays shut there. The rule may always leave s shut (`#meta` or a shard did not answer).

  After the recovery, nothing else goes wrong: no deposition, and the client sends nothing new (copies already in flight may still land). There is no "residual case": the old majority is gone for good.
- **Incarnations.** A recovery makes a new incarnation of the shard. Messages addressed to the old incarnation are not delivered to the new one, since links are set up per incarnation ("a replica is its member id plus its disk incarnation", §4.1). Messages the old incarnation *sent* stay deliverable: they are true reports of its past.
- **Reports are messages again.** In the first round, A read B's committed log directly, because a committed fact never became false. A recovery can now truncate a committed log, so every report is a real message. It enters the network the moment the sender's log (or an ack) makes it true, and may be delivered at any later time, any number of times.

### The bounds

| Bound | Shards | Writes | Depositions per shard | Moves per run | Recovery | For |
|---|---|---|---|---|---|---|
| `quick` | A, B | none | 1 | 1 | yes | a smoke test (`--quick`) |
| `move` | A, B | none | 2 | 1 | yes | the move, the table and recovery, deeply |
| `moves` | A, B | none | 1 | 2 | yes | a second move after the first ends; stale messages of an ended move |
| `three` | A, B, C | none | 1 | 2 | yes | moves to two targets |
| `write` | A, B | w1 to s, one resend, each copy to either shard | 1 | 1 | yes | positions and lost writes across a recovery |
| `dedup` | A, B | w1 to s, w2 to t, one resend each, window 1 | 1 | 1 | no | the floor, the carried outcomes, the `max` merge |
| `deep` | A, B | w1 and w2 to s, no resend | 1 | 1 | no | stamping and N with two writes in flight |

### The properties

| # | Property | Checked |
|---|---|---|
| 1 | At most one shard holds s open (a committed `open`, `unfenced`, reopening recovery, or genesis, with no later fence or shutting recovery) | every state |
| 2 | No position (epoch, seq) is stamped on committed writes by two shards | every state |
| 3 | Every write committed to s at A before a move's fence is at the target when it opens | every state |
| 4 | No acknowledged write goes missing from the state of the shard that holds s | every state before a recovery (after one, losses are allowed) |
| 5 | No attempt id commits twice | every state |
| 6 | A slot's position never goes back, and is never handed out twice | in each log; and on every commit of a write, its (epoch, seq) is above every position committed before, anywhere, ever |
| 7 | Liveness: with no more faults, every move finishes or is cancelled | from every reachable state with no recovery, with all messages lost, then no deposition, loss, recovery, or new cancel or abort; some path ends every move (AG EF) |
| 8 | An attempt its issuer took as refused never commits | every state |
| 9 | Whenever a shard holds s open, the table names it | every state |

### Runs

Every run is a full breadth-first search unless marked +. A run marked + is a mutant that stopped once a safety property had failed and 1,000,000 states had been explored (`--cap`, the default; `--cap 0` explores every mutant in full). A + count is what was explored, and properties not listed may fail too. Each cell gives the states, then the properties that fail, with the steps in each shortest counterexample.

**The text, the fix, and one fix left out at a time.** These always run in full.

| Run | `move` | `moves` | `write` | `dedup` | `deep` | `three` |
|---|---|---|---|---|---|---|
| `design`: the text as written | 47,754: 1 (20), 9 (15) | 530,385: 1 (20), 9 (15) | 1,251,562: 1 (20), 6 (26), 9 (15) | 327,308: all hold | 286,188: all hold | — |
| `fixed`: with the five fixes | 47,457: all hold | 898,312: all hold | 1,107,824: all hold | 351,262: all hold | 308,274: all hold | 7,510,764: all hold |
| without fix 1 (recovery ends the move) | 71,784: 9 (19) | 1,175,418: 1 (32), 9 (19) | 1,835,310: 9 (19) | | | |
| without fix 2 (table versions by move) | 24,474: 9 (16) | 309,780: 9 (16) | 579,576: 9 (16) | | | |
| fix 2 with a plain register instead | 31,713: 1 (19), 9 (15) | 598,753: 1 (19), 9 (15) | 746,372: 1 (19), 9 (15) | | | |
| without fix 3 (recovery writes the table) | 48,981: 9 (15) | 948,381: 9 (15) | 1,158,978: 9 (15) | | | |
| without fix 4 (fence binds incarnation) | 55,197: 1 (23), 9 (21) | 1,088,268: 1 (23), 9 (21) | 1,318,048: 1 (23), 9 (21) | | | |
| without fix 5 (reopen in the new epoch) | 45,837: all hold | 869,816: all hold | 1,069,440: 6 (25) | | | |

Property 7 (liveness) holds in every run of this table. The liveness graphs for `fixed` have 205, 3,694, 1,725, 5,694, 16,923 and 17,819 states.

The plan takes about 95 CPU-minutes. The two three-shard runs are the longest, at 9 and 15 minutes.


### What is still wrong in the text

The three first-round fixes are in, and they hold. Five gaps remain. All of them show up only after an unclean recovery: without one, the text as written holds every property. Each is shown by a run that leaves out one fix (a *reading*). Each trace is the shortest one, with "m0" as the move's name.

**1. A recovered shard resumes a move it should end.**
- **Sentences.** §4.2, "Crashes": "Each leader resumes from its own log." §4.2, recovery: "A slot it cannot settle ... stays shut and is listed." Nothing says what becomes of a move of a slot the recovery leaves shut.
- **Trace** (`fixed-but-recovery-resumes`, `move`, 19 steps, property 9):
  1. B commits its copy and `END(0)`, and its `s → B` is on the way to `#meta`.
  2. B appends `abort(m0)`, and it commits.
  3. B is recovered from a copy that ends before the abort. The table does not yet name B, so s stays shut at B.
  4. B's copy still shows the import, complete, so B resumes it.
  5. `#meta` takes `s → B`, then B's old write-back `s → A`.
  6. B has the ack for `s → B`, so it opens, while the table names A.

  On `moves` the same gap gives two shards holding s (property 1, 32 steps).
- **Fix:** "A recovered shard that does not reopen a slot ends its part in every move of that slot in its copy: it aborts an import, cancels an export it has not fenced, and never reopens the slot through a fence made before the recovery. The slot then settles by the rule above, or by the operator."

**2. The slot table row has no order, and "if it wrote s → B" cannot be known after a recovery.**
- **Sentences.** §4.2, "Cancelling": "If it wrote `s → B`, it writes `s → A` back." The `#meta` shard record: "the newest config winning."
- **Trace** (`fixed-but-table-by-writer`, `move`, 16 steps, property 9):
  1. B commits its copy and `END(0)`, and `#meta` takes `s → B`.
  2. B is recovered from a copy that has only `importing`. s stays shut, and B aborts (fix 1).
  3. B's log no longer shows that it wrote `s → B`, so it reports the abort without writing `s → A` back.
  4. A reopens s, while the table names B.

  If the row is a plain register (the last write to arrive wins), a late `s → B` lands after the write-back, and both shards hold s (`fixed-but-table-unversioned`, property 1, 19 steps).
- **Fix:** "Every write of a slot's table row carries a version: the move's name, the writer's incarnation, then the step (1 for `s → B`, 2 for `s → A` back). `#meta` keeps the highest. On an abort, B writes `s → A` back always."

  A version by the writer's own log position does not work. Positions from two shards, or from before and after a recovery, cannot be compared.

**3. A recovery that reopens a slot must write the table itself.**
- **Sentence.** §4.2, recovery: "So a recovered shard reopens a slot only when the slot table gives it that slot and its copy holds the slot's rows."
- **Trace** (`fixed-but-recovery-reads-table-only`, `move`, 15 steps, property 9):
  1. B commits its copy and `END(0)`, so its `s → B` is in flight.
  2. B appends `abort(m0)`.
  3. A is recovered from an empty copy. The table names A, and B's log end says it is not importing, so A reopens s.
  4. B's `s → B` lands, and the table names B while A holds s.

  The same happens to a recovered B, when an old write-back of its own lands after it reopens.
- **Fix:** "Before it reopens a slot, the recovered shard writes the slot's table row at the slot's new epoch, which beats every write made before the recovery."

**4. A fence must bind the target's incarnation.**
- **Sentences.** §4.2, step 0: "every message of the move carries the name, so a late message from an ended move is ignored." §4.2, "Cancelling": "A, on B's committed `abort`, commits `unfenced(s)`."
- **Trace** (`fixed-but-fence-ignores-incarnation`, `move`, 23 steps, property 1):
  1. B commits `importing(m0)` and `abort(m0)`, and `#meta` takes `s → A` back.
  2. B is recovered from an empty copy, so it no longer knows m0.
  3. A, which has not yet seen the abort, still asks B to import m0.
  4. B's new incarnation imports m0 and reports ready, and A fences on it.
  5. The *old* incarnation's abort report now arrives, and A reopens s.
  6. A's `END(0)` reaches the new B, which writes `s → B` and opens.

  Both shards hold s. The name is the same; the incarnation is not.
- **Fix:** "B's reports carry its incarnation. A's fence records the incarnation whose ready report it acted on. A sends the delta and `END` to that incarnation only, and reopens s only on an abort from it or a newer one."

**5. Reopening at N after a recovered B hands a position out twice.**
- **Sentences.** §4.2, "Cancelling": "`unfenced(s)`, which reopens s at A at N." §4.2, "A lost B": B's slots go back "by `unfenced` at its fence." §2: the epoch "changes only when `fero recover --unclean` may have lost its records."
- **Trace** (`fixed-but-unfence-at-old-epoch`, `write`, 25 steps, property 6):
  1. The client sends w1 to A, and a resend to B.
  2. The move completes, and B commits the resend at position 1.
  3. B is recovered from a copy with only `importing`. s stays shut at B, and B aborts.
  4. A reopens s at N = 0, in epoch 0.
  5. w1's first copy lands at A, which stamps it at 1 again.

  Position 1 of epoch 0 now names two records: B's lost one, which readers may have seen, and A's.
- **Fix:** "B's abort report carries its epoch, and `unfenced` reopens s at N in the higher of N's epoch and that one. So once B's records may have been lost, A stamps in a new epoch." The lost-B command needs the same: bump the slot's epoch when it gives the slot back.

**Tried, and not needed** (with one recovery per run, every property holds without them):
- **Names that include A's epoch.** A move named by its position can repeat after A's log is cut back. But the target remembers every name it has imported and refuses a repeat, so a repeated name only stalls the new move.
- **An import that counts until its abort is reported.** The recovery's own table write (fix 3) already beats any table write still in flight.

**Two rules that turn out not to be safety rules here:**
- **Asking the other shards before reopening** (mutant b, not caught). Once fix 3 is in, the recovery's table write at its new epoch already stops the other shard: its `s → B` can never be acked again. Without fix 3, the protocol fails with or without the question. So the question is defense in depth.
- **"B serves only after `open` commits"** is still not caught, as in the first round. A write B appends after an uncommitted `open` commits only with it, and no answer goes out before commit.


### Mutants

Each mutant removes or changes one rule of the fixed protocol. It runs on `move` and `write`, and on the bounds where its rule can matter.

| Mutant | The rule it removes | Runs (states) | Caught by (steps) |
|---|---|---|---|
| (a) `table-after-open` | §4.2 step 3: B "writes `s → B` into the slot table … then commits `open`" (B writes after `open`) | `move` 43,134; `write` 1,000,001+ | 9 (14) only |
| (b) `recovery-trusts-table` | §4.2 recovery: "asks every reachable shard … and refuses to reopen a slot any of them holds open or is importing" | `move` 48,861; `write` 1,168,836 | **not caught** (see the findings) |
| (c) `abort-keeps-table` | §4.2: "If it wrote `s → B`, it writes `s → A` back" | `move` 23,547; `write` 554,754 | 9 (16), 1 (18) |
| (d) `a-unfences-alone` | §4.2: "After the fence only B can give the move up" (A cancels and reopens on its own) | `move` 183,068; `write` 1,000,001+ | 9 (16), 1 (17) |
| (e) `no-exporting` | §4.2 step 0: A commits `exporting`, which names the move (the move lives in A's leader's memory, with no name) | `move` 35,743; `moves` 1,000,002+; `write` 787,217; `three` 6,554,919+ | 7 (3); on `moves` also 9 (18), 1 (20); on `three` also 9 (18) |
| `ready-before-copy-commits` (S1) | §4.2 step 1: B commits its copy "Only then does B tell A it is ready" | `move` 57,608; `write` 1,395,852 | 7 (9) only |
| `fence-without-ready` | §4.2 step 2: A fences "on B's ready report" | `move` 79,020; `write` 1,628,278 | 7 (4) only |
| `stream-before-fence-commits` | §4.2 step 2: "Only once `fenced` commits does A send B …" | `move` 106,679; `write` 1,000,001+ | 7 (12), 9 (12), 1 (14); on `write` also 4 (17), 3 (18), 2, 5, 6 (21) |
| `b-serves-before-open-commits` | §4.2 step 3: B "serves s only after `open` commits" | `move`, `write`, `dedup`, `deep`: 47,457 to 1,114,166 | **not caught** (see the findings) |
| `b-serves-before-open` | the same, B serving once its copy and `END` commit, before `open` | `write` 1,000,001+; `deep` 322,170 | 4 (15), 6 (18), 5 (22), 2 (23) |
| `fence-N-from-committed` | §4.2 step 2: "N is s's last sequence number in its log" | `write` 1,000,001+; `deep` 411,310 | 6 (12), 7 (13), 3, 4 (18), 2 (21) |
| `stamp-from-committed` | §2: "A new leader stamps on from its log end" | `deep` 500,268 | 6 (7), 3, 4 (22) |
| `no-carried-sequence` | §4.2: the carried state holds "its sequence and epoch" | `deep` 308,274 | 2, 6 (21) |
| `no-carried-outcomes` | §4.2: "the committed outcomes tagged with s" are carried | `write` 1,000,001+; `dedup` 353,390 | 5 (21) |
| `no-max-merge` | §4.2: "the issuer's highest call id, merged by `max` at B" | `dedup` 352,750 | 5 (24) |
| `unfence-on-appended-abort` | §4.2: "A, on B's committed `abort`, commits `unfenced(s)`" (on an appended one) | `move` 70,462; `write` 1,000,001+ | 7 (13), 9 (16), 1 (17) |
| `b-aborts-after-open` | §4.2: B commits `abort` "only while its log has no `open`" | `move` 48,384 (no writes: holds); `write` 1,000,001+ | 4 (20) |
| `guards-on-committed` | §4.2, "Two kinds of rule" (the three forbidding guards read on committed entries) | `move` 50,453; `write` 1,000,001+; `deep` 526,891 | 9 (18), 1 (20); with writes also 4 (18), 6 (17), 2, 5 (21) |

**16 of 18 mutants are caught.** The coordinator's (a), (c), (d) and (e) are among them. In short:
- **(a)** is caught only by property 9. B opens while the table still names A. The second shard holding s that the review feared does not appear: a recovered A asks B, and with fix 3 writes the table itself.
- **(e)** is caught with two shards. Without a logged move, a new A leader forgets the move, and B waits for ever (liveness, 3 steps). With two moves, an old move's abort report reopens A after a later move is fenced, and both shards hold s (property 1, 20 steps). A third shard C was affordable at this bound (9 minutes for this run). There, (e) fails in the same two ways, liveness (3 steps) and property 9 (18 steps), but the property-9 trace does not use C. A new import of the unnamed move picks up an older, aborted copy's `END`, which is the confusion that names prevent. So C adds no new way to fail at this bound.
- **S1** (`ready-before-copy-commits`) shows up here as liveness, not safety. A fences on a ready position B later loses. After the fence only the delta since that position crosses, and B refuses a delta with a gap, so the move hangs until B gives up.


### What this round leaves out

- **One recovery per run**, of A or of B, and then calm: no deposition and no new client send. So two recoveries (of both shards, or a second of one) are not covered. With two, a move name by position could repeat at a target that also forgot it. Liveness is checked only before a recovery, since the doc leaves an unsettled slot to the operator.
- **`#meta` itself.** It is never recovered and never loses a write. That it may be unavailable is modelled as delay only. A recovery may always leave s shut, as if `#meta` or a shard did not answer.
- **The residual case**, where the old majority still lives.
- **Incarnations at the link.** Messages addressed to a recovered shard's old incarnation are never delivered to the new one. A design whose links did not check incarnations would need more fixes than these five.
- **Scale.** Only A exports: no chained moves, no move back, no move of many slots, no shard rule, planner or move lease. At most two moves, three shards, two writes.
- **Rows and refusals.** Each write is one opaque cell, with no conditions or ops, so the only refusal is `stale-attempt`. Lock fence tables and segment names in the carried state are not modelled.
- **Readers.** No reads, subscribers, views, cursors or `log` readers.
- **Time.** No clocks or timeouts. A's cancel and B's abort are free choices, and liveness forbids new ones.
- **Partial order.** The model is plain breadth-first search, with no reduction, so the bounds stay small.

## First round: the protocol before the revision

The first round checked §4.2 as it stood at commit fc81eb7: no `exporting`, no ready report, no slot table, no recovery. The model, its traces and its full write-up are in commit 28ad0a2 (`git show 28ad0a2:docs/v5-spec/slot_move.md`). In short:

**The model.** Two shards A and B as abstract Raft groups (a committed log, a leader's tail lost on deposition, a lost tail that may come back until the next commit). One slot moved from A to B; slot t stayed at A. One issuer with rising call ids, resends, the window and the floor. A message set with duplication, delay and loss. Two bounds:
- `deep`: two writes to s, two depositions per shard;
- `wide`: writes to s, s and t under window 2, one deposition per shard.

**What held.** With each guard read the safe way, all eight properties held:
- `deep`: 3,669,799 states;
- `wide`: 4,302,406 states;
- property 7 (liveness): from every state.

**What was wrong in the text, now fixed:**
1. "Every step acts only on committed entries" was wrong for a guard that forbids a step.
   - Read literally, A took a write after its own uncommitted fence (12 steps to a lost acknowledged write). B aborted after its own uncommitted `open`, or opened after its own uncommitted `abort` (13 steps to two shards holding s).
   - Fixed by "Two kinds of rule".
2. §2 said a new leader "stamps on from its committed state, after any uncommitted tail it drops", though Raft keeps that tail.
   - Two committed records got one number (7 steps).
   - Fixed: §2 now stamps from the log end.
3. Appending the `stale-attempt` refusal of a resent copy let duplicates grow the log without bound.
   - Fixed: such a refusal is never appended.

**Mutants (first round).** 12 of 13 caught. The one not caught, B serving after appending `open` but before it commits, was not needed for any modelled property: a write after an uncommitted `open` commits only with it, and no answer goes out before commit.

| Mutant (rule removed) | Caught by (steps) |
|---|---|
| A fences before B's `importing` commits | 7 only (4) |
| A streams before its `fenced` commits | 1 (8), 7 (11), 3, 4, 6 (12), 2, 5 (15) |
| B serves after appending `open`, before it commits | not caught |
| B serves before `open` | 4 (10), 6 (12), 2, 5 (17) |
| B commits `open` without writing its copy | 3, 4 (12), 2, 5, 6 (15) |
| N from committed state | 6 (7), 7 (8), 3, 4 (12), 2 (15) |
| stamping from committed state | 6 (6) |
| sequence not carried | 2, 6 (15) |
| outcomes not carried | 5 (15) |
| no `max` merge | 5 (19), `wide` only |
| A cancels on B's appended `abort` | 7 (5), 1 (14) |
| A cancels without B's `abort` | 7 (6), 1 (11), 4, 6 (14) |
| B aborts after `open` | 1 (13), 4, 6 (14) |
