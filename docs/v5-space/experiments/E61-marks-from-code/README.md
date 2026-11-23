# E-61: marks written by app code, exactly once into fero

**Question** (LAYERS section 11: "Owed for the read surface" item 3, and "Models owed", the cut source log; API.md 3.11's "Still owed"; P-08, P-17). Exactly once into fero rests on marks: an output write carries `{ from: e }`, the output slot's leader keeps the highest mark per reader name and source slot, and skips a write at or below it. E-30 checked that rule with the mark written by the model itself, and a consumer that waited for every answer. E-55's claim 21 had app-code marks, but in a seeded stand-in with no Raft and no lost log tails. Two things are owed:
1. E-30's model with the marks written by **app code**: `{ from: e }` on each output write, the writes **not awaited**; bare marks for records with no output; the pacing rule; a refused output write; several outputs of one record to one slot; Raft with lost log tails; restarts from the share's cursor; share moves between owners.
2. A derived resource whose source has **cut its log below the marks**: the record form must stop with `expired` and never skip a record. It was reasoned only.

**Bar.** Every property holds on every bound; removing each rule breaks a property; at least 20 mutants, at least 90 % caught; with the log cut, the reader stops with `expired` and loses nothing.

**This is the second version.** A review of the first found that three of its claims failed and that several gaps needed a fix ([the review, and what changed](#the-review-and-what-changed)). Every result below is from the second version's runs.

**In short** (model-checked: every reachable state at small bounds; and seeded runs of the same model on bigger worlds):
- **The design holds, after three fixes the review forced.** On all 42 bounds (72 to 1,092,334 states each), each source record changes the target exactly once: no output applied twice (ONCE), none lost (LOST), no skip that stands for an output that never happened (HANDLED), no client told "applied" for an output that was not (ANSWER), and every reader can always finish (DONE, asked in every state). That is through owner crashes, lost uncommitted tails in the target's groups and in `#groups`, lost copies, failed writes that end the loop, slot moves, share moves with the old owner still running, the loop in two processes at once, refused and `fenced` writes, an async `fn`, and 22 more bounds, most of which combine these. In **4,000 seeded runs** on worlds with all of that at once (7 source records, 3 output slots, 3 owners, up to 9 faults), the design broke nothing.
- **What a refused output write does to its mark: it depends on why it was refused.**
  - **Refused on the row** (a condition about the row, a shape check): the refusal **raises the mark** and is final. A copy sent again is skipped. Without it, the copy lands after the condition turns true: refused, then applied (STAND, 10 steps).
  - **Refused `fenced`** (a lock token older than one the leader has seen): **no mark**, and not final. With a mark, a stale owner's refused write vetoes the new owner's copy of it, which is skipped and never lands (HANDLED, 15 steps). This was the first version's rule, and the review's first finding.
  - A skip answers **`skipped`** ("handled before"), never "applied" (else ANSWER, 10 steps). And a refusal is judged in issue order, like an apply (else HANDLED, 10 steps; the seeded runs found it first).
- **The cut log** (owed item 2): while the source keeps its log back to the marks, no reader stops (NOSTOP). When it cuts below them, the reader **stops with `expired`** and never skips; a reader that skips to the earliest kept record loses records (LOST in 5 and 6 steps; in 258 and 206 of 1,000 seeded runs). Before it stops, it **reads its marks again** and jumps to them if they are past the floor; else a share move and a cut stop a reader that lost nothing (NOSTOP, 11 steps).
- **App code carries two rules, not one.** For one record, `fn` makes the same writes in the same order on every run (else HANDLED, 9 steps; ONCE in the seeded runs). And every write of a record is made before `fn`'s promise settles: **the loop awaits `fn`**, and run()'s cursor passes a record only once `fn` returned. Without that, an async `fn` loses records (LOST in 4 and 5 steps; in 327 to 485 of 1,000 seeded runs).
- **The rules, by DEV-10:** **25 rules kept of 31 written; 23 shown needed** by a counterexample, and 2 undecided at the state limit (`fence.oseq`, which a smaller move bound shows not needed, and `bmark.above`). The first version counted 20 of 25. **8 rules are new** to the docs.
- **Mutants:** the engine's, 27 of 32 caught (84 %, under the 90 % bar); the 5 others stopped at the state limit with no break, and of the flips and swaps alone 4 of 7 are caught. The review's build-bug mutants: 16 of 17 caught on the 42 bounds; the one left, K14, is caught on a bound made for it (LOST, 19 steps), so it is a real bug: 17 of 17.
- **E-57 B5's full ablation**, owed by E-57, ran on its own model unchanged: 6 rules needed of 6, 7 of 7 mutants caught (not re-run: its model did not change).
- **Still open:** the engine's mutants miss the 90 % bar and two rules stay undecided; no seeded run reaches a `fenced` refusal, so those paths rest on two small bounds; and the picks for the owner's questions (what a skip answers, which slots `marks()` reads and where `target.mark(e)` goes, whether the loop awaits `fn`) are this study's, not decisions.

## Words used here

- **Source** and **target**: the record form reads the source's log (`changes()`) and writes the target. **fn** is the app's function, run once per source record `e`.
- **Mark**: `{ from: e }` on a write. At the output slot's leader, per **reader name** and **source slot**, the highest (source sequence, write number) handled. The leader applies a write above it and raises it in the same log entry; a write at or below it is **skipped**.
- **Write number** (w): a write's place among the writes of one record to one output slot (TRANSFORMS 3.4).
- **Issue order** (O.seq, `issue-order`): each writer numbers its writes to a slot; the leader takes write n only after n−1, and answers a later one `gap`.
- **Bare mark**: a mark with no output, `target.mark(e)`. derive() sends one to an output slot that got nothing from the last records, so that slot's mark keeps up.
- **Restart point**: where a loop starts reading after a restart. derive(): `target.marks(name)`, the lowest mark over the output slots, per source slot. consumer().run(): the **share's cursor**, a row in `#groups` (here the group gc), written now and then.
- **Share** and **owner**: a share is a part of the source that one owner runs at a time, by a lease with a **token**. After a **share move** the old owner may run on for a while (a **zombie**) until it notices.
- **A refusal on the row**: a condition about the row fails (`if: { version }`, `equals`, a shape check). The same for every writer. **A refusal about the writer**: `fenced`, a lock token older than one the leader has seen (`if: { lock }`, P-10). It depends on who writes.
- **The line**: the client's waiting writes. **Pacing**: the reader yields no record while the line is full (512 in fero; 1 or 2 here), and a marked write is never refused `backpressure`.
- **Floor**: the source's earliest kept record. A read below it gets **`expired`**.
- **A failed write**: a marked write the leader answers `gap`, or one lost with all its copies spent. LAYERS 3.3 and 8.8 step 7: it ends the loop with its error, and the loop starts again from the marks.

## Method

One exhaustive model in plain Python, [models/marks.py](models/marks.py), on E-16's engine ([../E16-controller-loop/engine/engine.py](../E16-controller-loop/engine/engine.py)) with E-17's rule language, as E-30 did, reusing E-20's Raft world (a crash keeps any prefix of the uncommitted tail; a lost tail may come back). Then seeded runs of the same model on bigger worlds ([harness/walk.py](harness/walk.py)). Nothing here is fero's code; the model is the design as API.md 3.11, LAYERS 3.3, 6.3 and 8.8, and PATTERNS sections 5 and 9 write it.

**The world** (not counted as rules): a source with one or two slots of committed records, which may cut its log; a target with output slots P, R and Q in Raft groups b0 and b1, and the cursor rows in a third group gc; one, two or three owners, each with a reader name; a condition on some writes, either on the row (true or false by a world flag that may flip) or a lock (`if: { lock }`, refused `fenced` when the writer's token is older than one the slot's leader has taken a lock write under). Copies can be lost. **One session's copies to one output slot arrive in issue order** (one ordered link to each leader, as TCP gives; a lost copy is sent again in order); copies of different sessions or slots arrive in any order. The first version let every copy arrive in any order; that path is kept as the variant `resend-any`. In an `async` bound, `fn` may await something before it writes (one record at a time is held inside `fn`).

**The loop**, as app code and the library run it. `start` reads the restart point from committed state. `read` takes the next record, if the line has room and `fn` has returned for the record before, and runs `fn`: every write of the record is numbered within its record per slot and in issue order per slot, and sent; nothing is awaited. derive() sends bare marks; run() writes the share's cursor now and then, only past records `fn` has returned for and whose writes are all answered, and again if gc lost it. A write lost on the wire is sent again in its session (up to 2 copies; 3 in the seeded worlds). **A failed write ends the loop** (a gap, or a write lost with its copies spent), and the supervisor starts it again from the marks. A read below the floor reads the marks (or cursor) again: at or past the floor, it jumps there; else the owner stops with `expired`.

**The leader** of an output slot takes a copy in issue order. At or below the mark: skipped, an entry that only takes the issue number, answered `skipped`. Above, with its conditions true: applied, the mark in the same entry. Above, with a condition on the row false: refused, and the refusal raises the mark. Above, with a stale lock token: refused `fenced`, with no mark. A slot move carries the slot's marks and its issue numbers.

**Properties.**
- ONCE: no output applied twice.
- LOST: a reader's **committed** restart point never passes a record with an output neither applied nor refused on its row (E-30's LOST, with the restart point for the cursor). Every variant judges it on the committed restart point; only the loop's own read changes in a variant.
- HANDLED (new): a committed skip of an output is of one applied, or refused on its row. A skip never stands for an output that did not happen.
- ANSWER (new): no client is told `applied` for an output that is not applied.
- STAND: no output both refused on its row and applied. This is **this study's proposal** (a refusal on the row is final); the pages promise nothing about refusals yet.
- NOSTOP: while the source keeps its log back to every reader's committed restart point, no owner stops `expired`.
- DONE: AG EF over calm steps, **asked in every state**: every reader done (each output applied once, or refused on its row; its restart point at the end), or stopped `expired` where the source may cut below its marks. A supervisor that gives up past a cap of lives would break it; none does (0 such states in every bound).

**State reductions** (not rules; each removes only orders of steps that change nothing a rule reads): a client learns a write's answer when its entry commits; a copy that can only ever be a dup is dropped; derive's "for a while" is "the last record run wrote nothing to the slot" (the guard "and no write to it waits" is now a rule, `bare.idle`).

**Bounds** (42; the design's states; all finished). The first 20 are the first version's; the other 22 were added after the review.

| bound | what it adds | states |
|---|---|---|
| `d-short` | derive(): x0 writes P and R, x1 writes P only (R needs a bare mark); one restart | 3,668 |
| `d-tail` | a leader crash that loses an uncommitted tail; a restart | 2,338 |
| `d-drop` | a lost copy; a restart | 1,020 |
| `d-two` | two outputs of one record to one slot; a lost tail; a line of one | 1,607 |
| `d-refuse` | x1's write has a row condition, false at first, may come true; a restart | 462 |
| `d-refuse2` | a row condition true at first, may turn false; a restart | 72 |
| `d-move` | slot R moves from b1 to b0 (fence and open) with writes in flight; a restart | 92,171 |
| `d-share` | the share moves to a second owner, the first runs on; the source cuts up to the marks | 435 |
| `d-bare` | x0 writes P, x1 writes R: a bare mark must name only records already run | 35,679 |
| `d-twice` | the four lines in two processes under one name, no share; a cut | 12,832 |
| `d-names` | two reader names write one slot from one source slot | 291 |
| `d-slots` | two source slots write one output slot | 4,142 |
| `d-pace` | three records, a line of one | 160 |
| `d-cut` | the source cuts its log anywhere, below the marks too | 616 |
| `r-short` | consumer().run(): as `d-short`, from the share's cursor, no bare marks | 1,907 |
| `r-tail` | lost tails in b0 or in gc (the cursor) | 7,213 |
| `r-two` | two outputs of one record to one slot | 150 |
| `r-refuse` | as `d-refuse` | 1,817 |
| `r-share` | a share move with a zombie owner; the source cuts up to the cursor | 2,088 |
| `r-cut` | the source cuts its log anywhere | 2,174 |
| `d-lock`, `r-lock` | both outputs under the share's lock (`if: { lock }`); a share move with the old owner running on | 345; 1,286 |
| `d-async`, `r-async` | an async `fn` that may await before it writes; a restart (3 records; 2 records) | 792; 803 |
| `d-refuse-then`, `r-refuse-then` | a refused write, then a second write of the same record to the same slot | 288; 441 |
| `d-flip2` | the row condition flips twice around a restart | 746 |
| `d-share-tail`, `r-share-tail` | a share move and a lost tail (in gc too, for run()); cuts up to the marks | 11,568; 35,065 |
| `d-share-restart`, `r-share-restart` | a share move and a restart | 24,135; 150,636 |
| `d-share-cut`, `r-share-cut` | a share move and a source that cuts anywhere | 1,320; 4,677 |
| `d-share-two` | a share move and two writes of one record to one slot | 190 |
| `d-cut-tail`, `r-cut-tail` | cuts up to the marks and a lost tail | 2,663; 10,495 |
| `d-share-cut-tail3` | three records, a share move, a lost tail and cuts up to the marks | 108,591 |
| `r-twice` | two processes in run() with no share (two cursor writers); a cut | 103,546 |
| `d-share-move` | a share move during a slot move | 874,075 |
| `d-twice-tail` | two processes and a lost tail | 1,092,334 |
| `d-bare-drop` | as `d-short`, with a lost copy where a bare mark is due | 73,056 |
| `d-refuse-drop` | x0 writes P twice, the second with a row condition; a lost copy; a restart | 618 |

**Seeded runs** ([harness/walk.py](harness/walk.py), [harness/walks.sh](harness/walks.sh); worlds in `WALKS` in the model): 7 source records over 2 slots, 3 output slots over 2 groups with a slot move, owners `d`, `d` (one share, a takeover) and `e`, writes with a row condition and one under the share's lock, records with no write and records with two writes to one slot, an async `fn`; up to 9 faults: 3 restarts, 2 leader crashes per group (gc included), 3 lost copies, a takeover; 2 condition flips; 3 or 4 cuts (`-cut` worlds: anywhere). A walk takes 200 random steps of any kind, then calm steps until none is left. Safety is checked in every state; a walk that ends with nothing left to do short of the goal breaks DONE. 1,000 seeds per world and per removal.

## Results

Machine: 4 vCPU, 15 GB, shared with other jobs (each job waited for its turn on the box); Python 3.13, standard library. Raw output: [results/design.txt](results/design.txt), [results/reach.jsonl](results/reach.jsonl), [results/design-ablation.json](results/design-ablation.json), [results/variants.jsonl](results/variants.jsonl), [results/mutants.jsonl](results/mutants.jsonl), [results/walks.jsonl](results/walks.jsonl), [results/traces.txt](results/traces.txt), [results/probe.txt](results/probe.txt), [results/b5-ablation.json](results/b5-ablation.json), and [results/summary.md](results/summary.md) (generated). In traces.txt the engine prints "STOPPED AT THE STATE LIMIT" for a run that stopped at its first counterexample; those runs are breadth first, so the trace is a shortest one. traces.txt drops each rule from the full design, so a step count there can differ by a few steps from the ablation's, which drops the rule from the 1-minimal set.

### 1. The design

All seven properties hold on all 42 bounds, with DONE asked in every state ([results/design.txt](results/design.txt)). The two biggest bounds of the review, which it stopped at 900,000 states, now finish: 874,075 and 1,092,334 states (the ordered link makes every bound smaller than in the first version: `d-move` has 92,171 states against 204,597).

**What the bounds reach** ([results/reach.jsonl](results/reach.jsonl), every state of every bound), so that a property does not hold for want of a case:
- an applied output in a lost tail: 9 bounds (`d-tail`, `d-two`, `r-tail`, `d-share-tail`, `r-share-tail`, `d-cut-tail`, `r-cut-tail`, `d-share-cut-tail3`, `d-twice-tail`);
- a loop ended by a failed write (a gap, or a write lost with its copies spent): 12 bounds, 67,215 steps;
- `expired` reached: `d-cut`, `r-cut`, `d-share-cut`, `r-share-cut` (1,247 states); the jump to the marks on `expired`: 17 bounds (10,306 steps);
- a takeover while the old owner runs: 13 bounds; a `fenced` refusal: `d-lock`, `r-lock` (40 steps); a skip of an output refused on its row: 7 bounds (265 steps); a record held inside an async `fn`: `d-async`, `r-async`;
- a supervisor that gave up: 0 states in every bound. Where the source keeps its log back to the marks, it never cut past a committed restart point (0 states); where it may cut anywhere, it did (4,936 states).

**Seeded runs** ([results/walks.jsonl](results/walks.jsonl)): the design broke nothing in **4,000 runs**, 1,000 on each of the four big worlds. Every run reached its goal or stopped `expired`: DONE was asked at the end of every run, since a failed write now ends the loop and the loop starts again (the first version's runs left 74 to 88 of 1,000 short of the goal, with copies spent). In the two worlds where the source keeps its log back to the marks, all 2,000 runs finished. Over those 2,000 runs the walks went through 10,080 loop starts (84 of them after a failed write), 5,476 leader crashes (4,002 lost tails, 1,591 of them with an output in the tail), 1,965 takeovers (669 with the old owner still running), 2,493 slot moves opened, 4,002 refusals on the row, 9,190 writes held inside an async `fn` and sent later, 6,000 cuts up to the marks and 3,528 writes skipped at their mark. In the two worlds where the source may cut anywhere (a cut weighs 0.02 against 1 for any other step, so cuts land late as often as early), readers finished in 665 and 761 runs and stopped `expired` in 335 and 239, never skipping a record.

### 2. Counterexamples found, and what fixed them

Each was found by the model, against the design as the pages write it or as this study first wrote it; each fix is in the design above, and each trace is in [results/traces.txt](results/traces.txt) (steps of the shortest trace now).

| # | what went wrong | shortest trace | fix |
|---|---|---|---|
| 1 | run(): a cursor write lost in gc's uncommitted tail was never written again; the cursor stayed behind for good | first version: DONE, `r-tail`, 9 steps | a model gap ("now and then" means until gc holds it): the loop writes it again |
| 2 | run(): a new owner read the cursor (1) while the old owner's last cursor write (2) was still in gc's tail; that write committed; the source cut its log to 2; the new owner wrote 1 over it and stopped `expired`, though nothing was lost | NOSTOP, `r-share`, 18 | **the cursor never moves back** (`cursor.ahead`); or E-22's fresh read (both hold) |
| 3 | derive(): after a share move, the old owner ran on and raised the mark past the new owner's read position; the source cut to the marks; the new owner hit `expired` and stopped, though nothing was lost | NOSTOP, `d-share`, 11; DONE, `r-share`, 9 | **read the marks again before stopping**, and jump to them if they are at or past the floor (`expire.stale`, `resync.jump`) |
| 4 | a refused write raised no mark; the restarted reader's copy came after the condition turned true, and landed: refused, then applied | STAND, `d-refuse-then`, 10 (`d-refuse`, 16) | **a refusal on the row raises the mark** (`refuse.mark`) |
| 5 | a write applied while its condition held; the restarted reader's copy came at the mark after the condition turned false, and was judged again: refused | STAND, `d-refuse2`, 10 | **a write at or below the mark is skipped, never judged again** (`refuse.above`) |
| 6 | (from the review) with every refusal raising the mark: the new owner applied x0, the old owner's x1 was refused `fenced` and raised the mark; the new owner's x1 was skipped, and x1 never landed | HANDLED, `d-lock` and `r-lock`, 15 | **a `fenced` refusal leaves no mark** (the variant `fenced-mark` keeps the first rule) |
| 7 | (from the review) a refused write's copy, sent again after a restart, was skipped and answered as done: the client was told "applied" | ANSWER, `d-refuse2`, 10 | **a skip answers `skipped`** (`skip.say`) |
| 8 | (from the review) an async `fn` held record x0 while the loop read x1; x1's write went out first and raised the mark past x0 | LOST, `d-async`, 5 | **the loop awaits `fn`** (`read.fnret`) |
| 9 | the same in run(): the cursor passed a record whose `fn` had not returned, so it had no write in the line yet | LOST, `r-async`, 4 | **the cursor passes a record only once `fn` returned** (`cursor.fnret`) |
| 10 | with `fenced` writes, the old owner's cursor write passed x1, whose write was fenced (an answer) but not yet applied by the new owner; a restart from that cursor skips x1 | LOST, `r-lock`, 14 | **keep the token on run()'s cursor writes** (`cursor.fence`, which the first version found not needed) |
| 11 | (from the review) with both bare-mark guards gone, a bare mark went out while a write to its slot waited; that write's copy was lost, the bare mark landed, and raised the mark past the lost write | LOST, `d-bare-drop`, 11 | **a bare mark waits until no write to its slot waits** (`bare.idle`), or bare marks keep issue order (`bmark.inorder`) |
| 12 | (from the seeded runs) a lost copy, then the next write of the same record to the same slot, refused on its row out of order: the refusal raised the mark past the lost write | HANDLED, `d-refuse-drop`, 10; in 4 to 13 of 1,000 seeded runs | **a refusal is judged in issue order too** (`refuse.inorder`) |

### 3. The rules, by DEV-10 (E-17's procedure, E-20's script)

[results/design-ablation.json](results/design-ablation.json), [results/summary.md](results/summary.md). E-20's `ablate20.py` (E-17's procedure without running the pinned world steps): pass 1, greedy drops in model-text order, a final pass that leaves a 1-minimal set, then the mutants of that set. 1,068 s for the last of four slices; the cache kept the work between slices.

**25 rules kept of 31 written** (a rule is one guard conjunct or one update; the 33 world steps, such as a commit or a copy taken off the wire, are pinned). **23 of them are shown needed** by a counterexample. Two are kept only because a run stopped at the state limit (1,300,000 states) with no break, so they are not shown needed and not shown free.

| rule | what it says | removing it breaks (shortest trace, from the 1-minimal set) | in the docs |
|---|---|---|---|
| `apply.above`, `skip.below` | apply a write above the mark; skip one at or below it | ONCE `d-refuse2` 9; HANDLED `d-refuse2` 4 | `srchi-marks` (E-30) |
| `apply.mark`, `bmark.mark` | the mark goes in the output's own entry (the bare mark's own entry) | ONCE `d-refuse2` 9; DONE `d-short` 0 | `srchi-marks`; API.md 3.11 |
| `fence.carry`, `open.carry` | a slot move carries the slot's marks | ONCE `d-move` 13 | `srchi-marks` |
| `cursor.answered` | run(): the cursor passes a record only once its writes are answered | LOST `r-two` 4 | `srchi-marks` (E-30's `commit.acked`); P-08 |
| `cursor.fence` | run(): a cursor write carries the share's token | LOST `r-lock` 14 | P-08; **the first version found it not needed** |
| `read.number` | each write carries its number within its record, per slot | HANDLED `r-two` 6 | TRANSFORMS 3.4 (E-57 B5) |
| `apply.inorder`, `refuse.inorder`, `bmark.inorder` | issue order: write n to a slot only after n−1, for an apply, a refusal and a bare mark | LOST `d-drop` 6; HANDLED `d-refuse-drop` 8; HANDLED `d-bare-drop` 10 | `issue-order` (owed by the first build) |
| `bare.send` | derive() sends a bare mark to an idle output slot | DONE `d-short` 0: the restart point never reaches the end | API.md 3.11 |
| `bare.read` | a bare mark names only a record already run | HANDLED `d-bare` 8 | implied ("for a record that writes nothing") |
| `expire.stop` | below the floor, and the marks too: stop with `expired` | DONE `d-cut` 1 | LAYERS 8.8 |
| `refuse.mark` | a refusal **on the row** raises the mark | STAND `d-refuse-then` 10 | **new** |
| `refuse.above` | at or below the mark: skipped, never judged again | STAND `d-refuse2` 10 | **new** |
| `skip.say` | a skip answers `skipped` (handled before), never `applied` | ANSWER `d-refuse2` 10 | **new** (API.md 3.11 says "answered as done") |
| `read.fnret`, `cursor.fnret` | the loop awaits `fn` before the next record; the cursor passes a record only once `fn` returned | LOST `d-async` 5; LOST `r-async` 4 | **new** |
| `cursor.ahead` | run(): the cursor row never moves back | NOSTOP `r-share` 18 | **new** |
| `expire.stale`, `resync.jump` | stop only when the marks (or cursor) are below the floor too; else jump to them | NOSTOP `d-share` 11; DONE `r-share` 9 | **new** |
| `fence.oseq` | a slot move carries the slot's issue numbers | undecided: without it `d-move` passes the limit. On a smaller move bound it is **not needed**, from the design and from the 1-minimal set ([results/probe.txt](results/probe.txt)): a gap now ends the loop, which starts again in a new session | owed: `issue-order` across a move (LAYERS 3.6) |
| `bmark.above` | a bare mark is taken only above the stored mark | undecided: with the six free rules dropped, `d-bare-drop` passes the limit. Dropped alone it breaks nothing (pass 1, and 0 seeded runs in 4,000) | implied |

**Not needed** (no property breaks without them, given the rest): `read.paced`, the reader's pause (it only bounds memory; never refusing a marked write is what counts, section 4); `resync.kept` (a jump to marks below the floor is harmless, and the stop follows); `skip.inorder`, `fenced.inorder` and `fenced.above` (a skip and a `fenced` refusal change no row and no mark, so their order and their comparison do not matter); and `bare.idle`, but only because `bmark.inorder` is kept: **one of the two is needed** (with both gone, LOST on `d-bare-drop`, 11 steps; in 22 and 23 of 1,000 seeded runs). The review's finding 6 holds.

**The verify bounds.** The 1-minimal set ran on `d-share-move` and `d-twice-tail` to the state limit with no break (the design finishes there at 874,075 and 1,092,334 states; the set with six rules dropped is bigger).

Where the 25 come from: the mark itself (compared, stored in the output's entry, carried with a slot move), 5, as in E-30's `srchi-marks`; run()'s cursor after answers, 1, and its token, 1; the write's number, 1; issue order, 3 (plus 1, undecided, to carry it with a move); bare marks, 3 (plus 1 undecided); the `expired` stop, 1; and **8 rules the docs do not have**: three for refusals and skips, two that await `fn`, one for the cursor, two for `expired`. The first version counted 20 of 25.

### 4. Each structural rule removed, and the other paths

These rules are not one guard or one update, so they are removed as variants of the model ([harness/variants.py](harness/variants.py)), each on the ablation's 40 bounds; breadth first, so each trace is a shortest one. The other paths, which should hold, ran on all 42.

| removal | what changes | breaks (bound, property, steps of the shortest trace) |
|---|---|---|
| `mark-apart` | the mark in its own entry, after the output | ONCE on all 8 of the 40 that reach an output in a lost tail (10): the tail keeps the output and drops the mark; the restart applies it again |
| `mark-first` | the mark in its own entry, before the output | HANDLED on the same 8 (8): the tail keeps the mark and drops the output; the copy sent again is skipped for an output that never happened |
| `key-slot` | marks per source slot only, not per reader name | HANDLED on `d-names` (8): reader `e`'s write is skipped at reader `d`'s mark |
| `key-name` | marks per reader name only, not per source slot | LOST on `d-slots` (7): a2's record is skipped at a1's higher mark |
| `no-wnum` | the mark without the write's number | HANDLED on the 6 bounds with two writes of one record to one slot (6): the second write is skipped |
| `nondet` | app code: the same record's writes in another order after a restart | HANDLED on 5 of them (9) |
| `unpaced` | as E-55 wrote it: a marked write past the line is refused `backpressure`, and the loop goes on | LOST on `d-pace` (8), `r-short` (9); DONE on 8 more bounds (0 to 4) |
| `marks-tail` | the loop reads the marks (or the cursor) with the uncommitted tail | LOST on 4 derive() bounds with a lost tail (11): `d-tail`, `d-cut-tail`, `d-share-tail`, `d-share-cut-tail3`; no run() bound |
| `marks-marked` | marks(): the lowest mark over only the slots that hold one | LOST on `d-short`, `d-move`, `d-bare-drop` (13), `d-bare` (11) |
| `judge-com` | the leader checks the mark against committed entries only | ONCE on every bound (8 to 10) |
| `skip-ahead` | on `expired`, jump to the earliest kept record | LOST on `d-cut`, `d-share-cut` (6), `r-cut`, `r-share-cut` (5) |
| `no-bare` | derive() sends no bare marks | DONE on `d-short`, `d-bare`, `d-move`, `d-bare-drop` (0): the restart point never reaches the end |
| `fenced-mark` | a `fenced` refusal raises the mark too (the first version's rule) | HANDLED on `d-lock`, `r-lock` (15): a stale owner vetoes the new owner's write |
| `read.fnret` and `cursor.fnret` dropped together | the loop does not await `fn` | LOST on `d-async` (5), `r-async` (4) |
| `stop-refuse` | the loop ends on a refusal and starts again (another policy) | holds on all 42; with `refuse.mark` dropped too, STAND on `d-refuse-then`, `r-refuse-then` (9), `r-refuse` (14), `d-refuse`, `d-flip2` (15) |
| `start-fresh` | run(): E-22's fresh read (a new owner starts only once no cursor write is pending in gc) | holds on all 42, also with `cursor.ahead` dropped |
| `marks-joined` | marks() reads only the output slots the reader joined (question 5) | holds on all 42 |
| `resend-any` | the first version's wire: copies in any order, a gap eaten, resends inside the session | holds on 41; `d-share-move` stopped at 1,500,000 states with no break |

The owed list's rules each break something when removed: the mark in the output's own entry (`mark-apart`, `mark-first`), per reader name and source slot (`key-slot`, `key-name`), the write's number (`no-wnum`, `read.number`), the cursor moved only after answers (`cursor.answered`), the bare mark (`no-bare`, `bare.send`), and the `expired` stop (`skip-ahead`, `expire.stop`). **`marks-tail` breaks on 4 bounds, not 9**: the review was right that the first version's count came from LOST reading the variant's own restart point. The rule (read the marks from committed state) is still needed, but only a lost tail shows it.

### 5. Seeded runs

A cell: seeds with a break, of 1,000, and the properties broken (most often first). Worlds in `WALKS` of the model; the `-cut` worlds cut the source's log anywhere.

| removal | `w-derive` | `w-run` | `w-derive-cut` | `w-run-cut` |
|---|---|---|---|---|
| `design` | 0 | 0 | 0 | 0 |
| `mark-apart` | 234 (DONE/ONCE) | 263 (DONE/ONCE) | 210 (ONCE/DONE) | 235 (ONCE/DONE) |
| `mark-first` | 329 (DONE/HANDLED/LOST) | 394 (DONE/HANDLED/LOST) | 303 (HANDLED/LOST/DONE) | 357 (HANDLED/LOST/DONE) |
| `key-slot` | 1000 (DONE/LOST/HANDLED) | 1000 (DONE/HANDLED/LOST) | 864 (HANDLED/LOST/DONE) | 838 (HANDLED/DONE/LOST) |
| `key-name` | 1000 (DONE/LOST/HANDLED) | 1000 (DONE/HANDLED/LOST) | 817 (LOST/HANDLED/DONE) | 788 (HANDLED/DONE/LOST) |
| `no-wnum` | 1000 (DONE/HANDLED/LOST) | 1000 (DONE/HANDLED/LOST) | 752 (HANDLED/LOST/DONE) | 800 (HANDLED/LOST/DONE) |
| `nondet` | 4 (DONE/HANDLED/LOST/ONCE) | 3 (DONE/HANDLED/LOST/ONCE) | 1 (DONE/HANDLED/LOST/ONCE) | 2 (DONE/HANDLED/LOST/ONCE) |
| `unpaced` | 1000 (DONE/LOST/HANDLED) | 1000 (DONE/LOST/HANDLED) | 851 (DONE/LOST/HANDLED) | 820 (LOST/DONE/HANDLED) |
| `marks-tail` | 0 | 0 | 0 | 0 |
| `marks-marked` | 154 (DONE/LOST/HANDLED) | 0 | 122 (LOST/DONE/HANDLED) | 0 |
| `judge-com` | 171 (DONE/ONCE) | 179 (DONE/ONCE) | 143 (ONCE/DONE) | 134 (ONCE/DONE) |
| `skip-ahead` | 0 | 0 | 258 (DONE/LOST) | 206 (LOST/DONE) |
| `no-bare` | 1000 (DONE) | 0 | 857 (DONE) | 0 |
| `fenced-mark` | 0 | 0 | 0 | 0 |
| `stop-refuse` | 0 | 0 | 0 | 0 |
| `resend-any` | 0 | 0 | 0 | 0 |
| `read.paced` dropped | 0 | 0 | 0 | 0 |
| `read.fnret` dropped | 485 (DONE/LOST/HANDLED) | 430 (DONE/HANDLED/LOST) | 389 (HANDLED/LOST/DONE) | 327 (HANDLED/DONE/LOST) |
| `read.number` dropped | 1000 (DONE/HANDLED/LOST) | 1000 (DONE/HANDLED/LOST) | 753 (HANDLED/LOST/DONE) | 801 (HANDLED/LOST/DONE) |
| `resync.kept` dropped | 0 | 0 | 0 | 0 |
| `resync.jump` dropped | 0 | 1 (DONE) | 0 | 0 |
| `expire.stale` dropped | 0 | 0 | 0 | 0 |
| `expire.stop` dropped | 0 | 0 | 331 (DONE) | 239 (DONE) |
| `bare.read` dropped | 971 (DONE/HANDLED/LOST) | 0 | 748 (HANDLED/DONE/LOST) | 0 |
| `bare.idle` dropped | 0 | 0 | 0 | 0 |
| `bare.send` dropped | 1000 (DONE) | 0 | 857 (DONE) | 0 |
| `cursor.answered` dropped | 0 | 994 (LOST/DONE/HANDLED) | 0 | 894 (LOST/DONE/HANDLED) |
| `cursor.fnret` dropped | 0 | 815 (LOST/DONE/HANDLED) | 0 | 683 (LOST/DONE/HANDLED) |
| `cursor.fence` dropped | 0 | 0 | 0 | 0 |
| `cursor.ahead` dropped | 0 | 0 | 0 | 0 |
| `apply.inorder` dropped | 0 | 9 (DONE/HANDLED/LOST) | 0 | 8 (HANDLED/DONE/LOST) |
| `apply.above` dropped | 441 (DONE/ONCE) | 480 (DONE/ONCE) | 385 (ONCE/DONE) | 416 (ONCE/DONE) |
| `apply.mark` dropped | 779 (DONE/ONCE) | 692 (DONE/ONCE) | 652 (DONE/ONCE) | 597 (ONCE/DONE/STAND) |
| `skip.inorder` dropped | 0 | 0 | 0 | 0 |
| `skip.below` dropped | 1000 (DONE/HANDLED/LOST) | 999 (HANDLED/DONE/LOST) | 919 (HANDLED/DONE/LOST) | 933 (HANDLED/LOST/DONE) |
| `skip.say` dropped | 3 (ANSWER) | 6 (ANSWER) | 4 (ANSWER) | 7 (ANSWER) |
| `refuse.inorder` dropped | 4 (DONE/HANDLED/LOST) | 13 (DONE/HANDLED/LOST) | 5 (DONE/HANDLED/LOST) | 11 (DONE/HANDLED/LOST) |
| `refuse.above` dropped | 0 | 0 | 0 | 0 |
| `refuse.mark` dropped | 1000 (DONE) | 0 | 717 (DONE) | 0 |
| `fenced.inorder` dropped | 0 | 0 | 0 | 0 |
| `fenced.above` dropped | 0 | 0 | 0 | 0 |
| `bmark.inorder` dropped | 0 | 0 | 0 | 0 |
| `bmark.above` dropped | 0 | 0 | 0 | 0 |
| `bmark.mark` dropped | 1000 (DONE) | 0 | 802 (DONE) | 0 |
| `fence.carry` dropped | 59 (DONE/ONCE) | 56 (DONE/ONCE) | 39 (DONE/ONCE) | 53 (ONCE/DONE) |
| `fence.oseq` dropped | 0 | 0 | 0 | 0 |
| `open.carry` dropped | 72 (DONE/ONCE/NOSTOP) | 58 (DONE/ONCE) | 53 (ONCE/DONE) | 53 (ONCE/DONE) |
| `bare.idle`, `bmark.inorder` dropped | 23 (DONE/LOST/HANDLED) | 0 | 22 (LOST/DONE/HANDLED) | 0 |

states_with_an_output_in_a_lost_tail (9, 822183, ['d-tail', 'd-two', 'r-tail', 'd-share-tail', 'r-share-tail', 'd-cut-tail', 'r-cut-tail', 'd-share-cut-tail3', 'd-twice-tail'])

- **The design broke nothing in 4,000 runs.** Every structural removal breaks here too, but two: `marks-tail` (0 in every world: only a restart that reads marks from a tail which is then lost shows it, as in section 4) and `fenced-mark` (see the last point). The two other paths, `stop-refuse` and `resend-any`, hold, as they should.
- **`refuse.inorder` was found here first.** Without it, 4 to 13 runs of 1,000 broke HANDLED and LOST, while no bound did: a copy is lost, and the next write of the same record to the same slot is refused on its row out of order; the refusal raises the mark past the lost write. The bound `d-refuse-drop` was then added; it breaks in 10 steps (section 2, row 12).
- **Seven rules the ablation keeps never broke here:** `expire.stale` and `cursor.ahead` (each needs a share move, the old owner running on, and a cut at the right moment); `refuse.above` (an apply, a restart, and the condition turning false, in that order); `cursor.fence` (it needs a `fenced` write, see the next point); `bmark.inorder` alone (dropped with `bare.idle`, it breaks in 22 and 23 of 1,000); and the two undecided ones, `bmark.above` and `fence.oseq`. The bounds catch the first five (section 3).
- **No seeded run reached a `fenced` refusal** (0 in each world). A write is refused `fenced` only when it is above the mark and a newer owner has already taken a lock write to that slot; the seeded worlds have one write under the lock, so a stale owner's copy of it is always at or below the mark the newer copy set, and is skipped. So `fenced-mark`, `fenced.inorder`, `fenced.above` and `cursor.fence` are checked only on `d-lock` and `r-lock`.
- `nondet` breaks rarely (1 to 4 of 1,000): it needs a restart between the two writes of one record to one slot. `resync.jump` broke once (1 of 1,000 in `w-run`), the first seeded run to catch it.

### 6. Mutants

The review asked for the score to be split, since a rule drop that the ablation kept is caught by construction. So the three kinds are apart here.

**The engine's mutants of the 1-minimal set** ([results/design-ablation.json](results/design-ablation.json)): **32; 27 caught (84 %)**. None is shown to survive: the 5 not caught each stopped at the state limit with no break.
- Rule drops: 25; 23 caught (by construction, as section 3 shows). Not decided: `bmark.above` and `fence.oseq`.
- Comparison flips: 6; 4 caught (`bare.read`, `apply.above`, `skip.below`, `refuse.above`). Not decided: `cursor.ahead` flipped from `>` to `>=` (gc takes the same cursor value again; it held on all 40 sweep bounds, as in the first version where it survived) and `bmark.above` flipped.
- Swaps: 1, the fence's two carry updates, not decided (they touch different fields, so it is very likely equivalent).
- **Flips and swaps alone: 4 of 7 caught.**

**Build-bug mutants** ([harness/mutants.py](harness/mutants.py), [results/mutants.txt](results/mutants.txt)): plausible mistakes in a build of the library or the leader, K01 to K15 from the review and K16, K17 added here. Each runs on the bounds in order, cheap first, until one breaks (breadth first, so a shortest trace).

| mutant | the bug | first caught |
|---|---|---|
| K01 | the fence carries only the committed marks | ONCE, `d-move`, 13 steps |
| K02 | the old group keeps judging writes until its fence commits | ONCE, `d-move`, 13 |
| K03 | the client takes an answer from the uncommitted tail | ANSWER, `d-refuse2`, 3 |
| K04 | a restarted loop keeps its old session number | ANSWER, `d-pace`, 11 |
| K05 | a skip is answered before the log end it was judged on commits | LOST, `r-two`, 11 |
| K06 | an applied write marks its whole record (no write number stored) | HANDLED, `r-two`, 6 |
| K07 | a refused write marks its whole record | LOST, `d-refuse-then`, 4 (**the review's survivor, now caught**) |
| K08 | marks() takes the highest mark over the slots | LOST, `d-short`, 13 |
| K09 | an output's mark counts its record as whole | DONE, `d-refuse-drop`, 6 |
| K10 | a bare mark is sent while a write waits, and bare marks skip issue order | LOST, `d-bare-drop`, 11 |
| K11 | run()'s cursor passes the last record before its writes are answered | LOST, `r-two`, 4 |
| K12 | issue order is kept per process, not per session | DONE, `r-two`, 4 |
| K13 | marks() takes the lowest mark over only the slots that have one | LOST, `d-short`, 13 |
| K14 | on `expired`, the marks are read again with the uncommitted tail | survives all 42 bounds; **LOST in 19 steps on the probe bound** (below) |
| K15 | run()'s cursor treats a refused write as not answered | DONE, `r-refuse-then`, 0 |
| K16 | a loop that ended on an error starts again from its own position, not the marks | DONE, `d-refuse-drop`, 4 |
| K17 | the leader's skip compares the record only, not the write's number | HANDLED, `r-two`, 6 |

- **16 of 17 caught on the 42 bounds (94 %); 17 of 17 with the probe bound.**
- **K14 is a real bug.** The review could not tell whether it was a bug or harmless. With output marks a record is read again, so the jump must pass a record whose output sits in a tail that is then lost. That takes four records, a share move, a lost tail and a cut: the probe bound `share-cut-tail4` ([harness/probe.py](harness/probe.py), [results/probe.txt](results/probe.txt)). The design holds there (861,498 states, every one judged for DONE). K14 breaks in 19 steps: the old owner applies x2 and x3 (not yet committed); the new owner meets `expired`, reads the marks with that tail and jumps past x2; the leader crashes and the tail is lost; x2's output never lands. So "read the marks from committed state" covers the jump on `expired` too.

**Hand-written removals** (section 4): 13 removals and one pair of dropped rules, each breaking a property. The review is right that they were chosen to break, so they are not counted in a score.

### 7. E-57 B5's full ablation

E-57 B5 widened E-30's model to two outputs of one record in one slot and ran it on 12 bounds; its DEV-10 ablation was started and stopped. Run here unchanged (its model read only, [results/b5-ablation.json](results/b5-ablation.json)): **6 rules needed of 6** (E-30's five, plus `emit.inorder`, the order rule), each breaking a property when dropped (LOST, ONCE, or DONE for the mark in the entry); **7 of 7 mutants caught**; 255 s. Its order rule is "the next output only after the one before is answered"; here the writes are not awaited, and the same order comes from issue order at the leader.

## Verdict

**The design holds, with changes.** The owed model is done. With marks written by app code and the writes not awaited, each source record changes the target exactly once through every fault modelled, alone and combined (42 bounds, 4,000 seeded runs). When the source cuts its log below the marks, the reader stops with `expired` and skips nothing.

The first version's "the design holds" did not stand as written. Three of its claims failed (the review's findings 1, 3 and 4), and this version fixes them:
- **A refused output write raises its mark only when the refusal is about the row.** A `fenced` refusal leaves no mark and is not final. A skip answers `skipped`, never `applied`. A refusal keeps issue order, like an apply.
- **App code carries two rules**: for one record, the same writes in the same order on every run; and every write made before `fn`'s promise settles. The loop awaits `fn`.
- **`marks-tail` breaks only where a restart reads marks from a tail that is then lost** (4 bounds, 0 seeded runs), not on 9 bounds. The rule still stands, and it covers the jump on `expired` too (K14).

It takes **25 rules (23 shown needed), not E-30's 5 and not the first version's 20**. Eight are new to the docs: a refusal on the row raises the mark; a write at or below the mark is never judged again; a skip answers `skipped`; the loop awaits `fn` (two rules); run()'s cursor never moves back; an `expired` reader reads its marks again and jumps to them (two rules). The token on run()'s cursor writes, which the first version found not needed, is needed once `fenced` writes exist. The reader's pause is still not needed for exactly once; it only bounds memory.

What this would change in the pages (not edited here): API.md 3.11 (what a skip answers, a row refusal against a `fenced` one, which slot `mark(e)` names, the loop awaits `fn`) and P-08/P-17; LAYERS 3.3 (the `{ from: e }` row: +8 rules, issue order for refusals and bare marks), 6.3 and 8.8 step 5 (the refusal, the re-read on `expired` from committed state); PATTERNS 5 step 7 (the cursor keeps its highest value, and its token stays) and 9. LAYERS 11's read-surface item 3 and "Models owed" item 21 can be marked done, with the pacing rule in a real client still owed.

## The review, and what changed

A review of the first version (its probes ran the model unchanged, beside it) found that three of its claims did not hold and that several gaps needed a fix. Each finding was checked again here, against the pages and by running the model. All eleven hold, one in part. What changed for each:

| # | the finding | checked | what changed |
|---|---|---|---|
| 1 | `refuse.mark` (every refusal raises the mark) lets a stale owner's refused write veto the new owner's copy: a `fenced` refusal depends on who writes, not on the row | holds: API.md's `MarkOpts` takes `if`, `Cond` has `lock`, and its error table lists `fenced` for "a stale deriver's write" | outputs with `if: { lock }` (P-10) in the model; **a refusal raises the mark only when it is about the row; a `fenced` refusal leaves no mark** and is not final; a new property, HANDLED; bounds `d-lock`, `r-lock`; the first rule kept as the variant `fenced-mark` |
| 2 | a skip answers "done" for an output that was refused | holds (API.md 3.11: skipped "and answered as done"). Its side point, that a refused write nobody awaits ends a Node process, does not hold as written: API.md's `Judged` makes a promise only when it is awaited | **a skip answers `skipped` (handled before), never `applied`** (`skip.say`); a new property, ANSWER |
| 3 | an async `fn` loses records; the types allow it (`fn: (e) => unknown`) | holds: the pages never say the loop awaits `fn` | an async `fn` in the model; **the loop awaits `fn`** (`read.fnret`) and **run()'s cursor passes a record only once `fn` returned** (`cursor.fnret`); bounds `d-async`, `r-async`; a second rule for app code |
| 4 | `marks-tail`'s breaks are an artifact: LOST read the variant's own restart point | holds | LOST, DONE and the source's cut now read the committed restart point in every variant; only the loop's own read changes |
| 5 | `target.mark(e)` names no slot, and `marks()` is a lowest mark over "the output slots": which ones, at what cost? | holds | the lowest mark over only the slots that have one is now the variant `marks-marked` (it loses records); a cheaper reading, `marks-joined`, is modelled; the cost is priced; a question for the owner |
| 6 | `bmark.inorder` was "not needed" only because an uncounted guard did its work | holds | the guard is now a rule, `bare.idle`; the ablation keeps one of the two |
| 7 | the pages' path for a failed write (a gap, or a lost link, ends the loop, which restarts from the marks) was not the one modelled, and DONE was not asked once a write spent its copies | holds (LAYERS 3.3, 8.8 step 7) | **that path is now the model's**: a gap, or a write lost with its copies spent, ends the loop, and the supervisor starts it again from the marks; one session's copies to one slot arrive in order (one ordered link); **DONE is asked in every state**. The first version's path is kept as the variant `resend-any` |
| 8 | lost tails were combined with almost nothing else | holds | 22 bounds added: the review's 15 distinct ones, a 3-record share move with a lost tail and a cut (the review's sixteenth, made longer), the four above, and two found later (`d-bare-drop` for finding 6, `d-refuse-drop` for a seeded-run break); the biggest finish now |
| 9 | the mutation score counted mutants caught by construction | holds | the score is split: rule drops apart, flips and swaps apart; the review's 15 build-bug mutants and 2 more run on every bound |
| 10 | "the pacing never deadlocks" is true by construction | holds | moved to the limits |
| 11 | smaller points | hold | the walker counts takeovers with the old owner running; snapshots and compaction, a stale `e`, and a condition read from outside `e` are in the limits or the app-code rule; STAND is listed as this study's proposal |

## Questions for the owner

Each has this study's pick and what the model shows; none is in a decision yet.

1. **What does a refused marked write do to its mark?** This study: **it depends on why it was refused.** A refusal on the row (a condition about the row, a shape check) raises the mark: the refusal is final, and a copy sent again is skipped (without it: STAND). A refusal about the writer (`fenced`, and so `forbidden`, or a write rule that reads who writes) leaves no mark and is not final: the right writer's copy must still land (with a mark: HANDLED, a stale owner vetoes the new owner's write). The other ways: say that no refusal is final (then a refusal of a marked write can be undone by a later apply, STAND); or forbid `if: { lock }` on a marked write, since marks already make a stale owner's writes harmless, and keep `fenced` for the view form.
2. **What does a skip answer?** This study: `skipped`, meaning "handled before", never `applied`. API.md 3.11 says "answered as done". The other way: the mark keeps one bit, applied or refused, and a skip answers with it; but the bit only speaks for the write at the mark, not for an older one below it.
3. **What happens to a refusal nobody awaits?** API.md's `Judged` makes a promise only when it is awaited, so it is not an unhandled rejection; the pages do not say what happens instead. This study's pick: the loop goes on, and the refusal is logged once. The other way, `stop-refuse` (the loop ends on a refusal and starts again), also holds.
4. **Do derive() and run() await `fn`?** This study: yes, both await `fn`'s promise before the next record, and run()'s cursor passes a record only once `fn` has returned for it (two rules, each needed). App code then carries a second rule: `fn` makes every write before its promise settles (no write left in a promise `fn` does not return). The other way: type `fn` as `(e) => void` and make the second app rule "no await before a write".
5. **Which output slots does `marks(name)` read, and where does `target.mark(e)` go?** The model's design reads the lowest mark over every output slot of the target and sends bare marks to every idle one; with 4,096 slots a resource, that is up to 4,095 bare marks a round for a deriver that writes one slot. The cheap reading, "only the slots that hold a mark", loses records (`marks-marked`). This study's pick: **`marks-joined`**, a row per (reader name, source slot, output slot) in `#groups`, committed before the first write to that slot, and one home slot before the first record; `marks()` reads only joined slots, and bare marks go only to them. It holds on all 42 bounds (it is not in the seeded worlds). It costs one commit per (name, source slot, output slot), once. The other ways: `mark(e)` on a lens (the app names the slot); or marks kept per group (fewer, but then issue order must be per group too; not modelled).
6. **How does run()'s cursor keep from moving back, and is its fence needed?** This study: gc applies a cursor write only above the row's value, and **the token on run()'s cursor writes is needed after all**: with `fenced` writes, a zombie's cursor write could pass a record whose write was fenced and not yet applied by the new owner (LOST, 14 steps). The first version found the fence not needed and proposed dropping it from run(); that pick is withdrawn. The other way: the cursor does not count a `fenced` write as answered.
7. **On `expired`, read the marks again before stopping?** This study: yes; without it, a share move plus a log cut stops a deriver that lost nothing.
8. **How is app code told its two rules?** (the same writes in the same order on every run; every write made before `fn`'s promise settles). A user rule in the docs, and later a dev check that runs `fn` twice on one record and compares the writes. A condition `fn` reads from outside `e` (`if: { version }` taken from the target) makes a re-run a different write, so it breaks the first rule.

## What the model leaves out

- **Small bounds.** Two to five outputs per bound, one or two restarts, one share move, one slot move, one or two faults besides. The seeded runs widen that (7 records, 9 faults) but sample it; they prove nothing about the states they miss.
- **Abstract Raft and an abstract wire**, as E-20 and E-30: a leader crash keeps any prefix of the tail; copies are lost, and arrive in order per session and slot. No elections, no clocks, no leases timing out: the zombie owner runs until a calm step says it noticed.
- **The ordered link is an assumption.** One session's copies to one slot arrive in issue order. The first version allowed any order; under any order, the design keeps safety (`resend-any`), but the path the pages write (a gap ends the loop) is not modelled there, and `bare.idle` or `bmark.inorder` becomes needed again (a bare mark can overtake a waiting write).
- **The reductions** (section Method) remove interleavings that no rule reads; a resend while a copy is still on the wire, and a client that learns its answer late, are not explored.
- **The source is already committed.** Its own Raft (a record read then lost) is E-31's model, not this one. A slot move in the source is not modelled.
- **Answers are committed answers.** A marked write takes no early stage (API.md 3.5); with answer stages, "answered" in the cursor rule must mean committed (W1).
- **fn is fixed per record.** The record form with rows (`{ rows: true }`) is not modelled; nor are writes to several targets from one fn. The model looks a mark up by output id, so app code that passes another `e` (a stale `e` kept in a closure) cannot be expressed.
- **Conditions are one flag and one lock.** A shape refusal (`bad-shape`, `absent-path`) behaves like a row condition that stays false; `too-many-outputs` is not modelled. A lock output never sits on a slot that moves (the fence would have to carry the lock table).
- **No `fenced` refusal in the seeded runs.** The seeded worlds have one write under the lock, so a stale owner's copy of it is always skipped at the mark first (section 5). The `fenced` paths are checked only on the two small bounds `d-lock` and `r-lock`.
- **Marks in snapshots and log compaction** (LAYERS 3.3: marks ride target snapshots) are not modelled: every mark is read from the log.
- **The pacing check is weak.** The leaders never wait for the reader here, so no cycle can form by construction; that DONE holds with a line of one says nothing about deadlock. A real deadlock through a shared process (the deriver's process also serving the target's leader) is not modelled. The cap of 512 and 64 MB in a real client stays owed (LAYERS 11, read surface item 4).
- **NOSTOP rests on a reading** of "the source keeps its log back to the marks": a cut never passes any reader's committed restart point.
- **One ablation order.** The ablation drops rules in model-text order only (DEV-10 (e)'s second order was not run). Its two biggest bounds are verify bounds: the 1-minimal set ran there only to the state limit. Two rules stay undecided at the limit (section 3).

## Files

| file | what it is |
|---|---|
| [models/marks.py](models/marks.py) | the model: world, loop, leader, properties, the 42 bounds, the variants, the seeded worlds |
| [harness/walk.py](harness/walk.py), [harness/walks.sh](harness/walks.sh) | the seeded runs |
| [harness/variants.py](harness/variants.py) | each structural removal and each other path, on every bound |
| [harness/mutants.py](harness/mutants.py) | the build-bug mutants K01 to K17 |
| [harness/reach.py](harness/reach.py) | what each bound reaches (lost tails, `expired`, jumps, loop ends, fenced writes, held records) |
| [harness/probe.py](harness/probe.py) | `fence.oseq` on a smaller move bound, and K14 on a bound made for it (`share-cut-tail4`) |
| [harness/traces.sh](harness/traces.sh) | the shortest counterexamples cited here |
| [harness/report.py](harness/report.py) | results/summary.md |
| [run.sh](run.sh) | `quick` (100 seeds a world, the removals on the sweep bounds), `full` (1,000 seeds, the other paths on all bounds, the ablation), `core`, `ablate`, `report` |
| results/ | the raw output named in Results |
