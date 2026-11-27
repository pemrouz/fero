# The one-commit slot move, in full

A model study for slice 3: three TLA+ models. No product code.

Each claim below is marked: *(counted)* from the ledger or the record, *(checked)* by the model checker on every reachable state at the stated bounds, *(measured)* a time or a state count from a run here, or *(reasoned)* argued and not run.

## Words

- A **slot** is a fixed share of a resource's keys. A **group** is one Raft group; it serves some slots.
- A **move** hands one slot from the group that serves it (the **source**) to another group (the **target**).
- The **home group** is the resource's first group. Its log holds the **slot table**: one **row** per slot, naming the slot's group.
- The **fence** is the source's one log entry for a move. Once it is in the source's log, the source takes no write to the slot.
- The **final copy** is the target's one log entry for a move. When it commits, the target serves the slot.
- The **carried set** is the state that travels with the slot, beside its rows.
- A **stream** is one writer's writes to one slot. Its **high mark** is the highest number the slot has taken from it.
- The **window** is the time the slot takes no writes: from the fence to the final copy's commit.
- An **unclean recovery** restarts a group that lost its majority from the copies that answer; entries that had committed may be lost. A group's **incarnation** counts its lives: it goes up at each recovery. A slot's **epoch** is the first half of every position (epoch, sequence); it goes up when records may have been lost.
- A **member** is one server's copy of a group. A **term** is one leader's time, as in Raft.

## The question

Does the one-commit slot move hold in its full form: with the real carried set, the slot table in the home log, the home group down, lost and late messages, a membership change, and two faults?

Three models answer it, each with a part of that world (see "The models"). The design record owes this model before the slot-move slice (READY M6; GROUPS 4.3 rows 6 and 8; LAYERS 2.6). What existed was the core: a probe with crash faults only, no table and no early copy (E-17b, `pslot-fused`), and an older model of the three-commit form (E-15).

**Verdict: the move holds in every world the three models have, and the models found nine things the ledger must settle first.**

- **The first model** (groups as single logs, the whole carried set, the table in the home log, any group down, a membership change). Every safety property holds on every bound, 9 small and 8 big *(checked)*. The four reach checks reach their goals, the hardest one included: a move that completes with the home group down from before the fence, a membership change in both groups, a group that lost its majority and came back, and a leader change *(checked)*.
- **The second model** (stored reports, an unclean recovery, the carried set sent early). Every safety property holds on 16 bounds, the largest of 6,480,516 states *(checked)*. Six reach checks reach their goals.
- **The third model** (one group with its members, for the record's K-01). Every safety property holds on 10 bounds, the largest of 4,969,277 states: a move that meets a membership change, two member faults and a second election *(checked)*. Three reach checks reach their goals.
- **Finding 1.** "One move at a time" needs a meaning for "the last move has ended". If a committed abort is enough, the slot table ends up naming a group that does not serve the slot, for good, in 11 steps *(checked)*.
- **Finding 2.** With the ledger's rule that the row is written back before the source reopens (`slot-table.5`), a slot can be stuck with no writes for as long as the home group is down: 998 of 6,688 states with the home group down *(checked)*. If the reopen does not wait for the row, no state is stuck, and every safety property still holds *(checked)*. This is what is left of GROUPS H4.
- **Finding 3.** For the window to be the fence and the final copy alone, the row must be written before the fence. Then `slot-move.21` can never apply, and one clause of `slot-table.5` is always true *(checked: `RowFirst`)*.
- **Finding 4.** The source must never fence the same move twice. The ledger has no such rule. Without it, a late report after the slot has moved there and back fences the slot for good *(checked)*.
- **Finding 5.** As the rules are written, the window holds two commits, the fence's and the final copy's, where the record's 10 ms bar rests on one. The model shows one way to one commit that keeps every property *(checked)*.
- **Finding 6.** One rule is not enough for an unclean recovery. The ledger has `slot-table.7` alone. The second model needs nine rules, R1 to R7, R9 and R10 in its section; with any one of them gone a property fails in 2 to 24 steps *(checked)*.
- **Finding 7.** Finding 4's rule has a strong form and a twin: a group never fences, and never takes a final copy, for a move older than the newest row its log names (R9). That twin also covers `slot-move.8` *(checked)*. Finding 10, in the decided form, shows the fence half must bar the newest move too.
- **Finding 8.** The carried set sent early needs a base: the fence names the place the delta starts from, and the target opens only if its early copy stands at that place. Without the check a record is applied twice in 12 steps *(checked)*.
- **Finding 9.** `slot-move.22` must count the voters of the newest configuration in the leader's log, committed or not. Counted in the committed one, a slot opens in a group of two voters in 10 steps *(checked, third model)*.
- Planted mistakes: 108 of 131 caught (82 %) over the three models, against a bar of 85 %. By model: the first 42 of 46 (91 %), the second 48 of 56 (86 %), the third 18 of 29 (62 %). The first and the second model reach the bar. The third does not, and the three together are just under it. Every mistake that is not caught is explained in "Planted mistakes": most change nothing these worlds can see, and three need a deeper Raft model than the third one's short form.

- **A second reading** ran every counted bound again (the same results and state counts), added 15 bounds that put faults side by side that had not met, all passing, and planted 24 more mistakes on lines the first list does not have, 22 caught. It found no failing property. It found rule lines of the second model that carry no mark, and it narrows three of the claims below. See "A second reading".

- **After card 0002** the owner took the proposals, and the move now runs in the decided form: one commit in the window, and the source's reopen first. All 70 of its bounds end as they should: 53 safety bounds pass, the largest of 11,658,335 states; 15 reach goals are reached; and the 2 stall checks find no stuck state, with the home group down too *(checked)*. Of 53 mistakes planted on the lines of the new and changed records, 49 are caught (92 %) *(measured)*. **Finding 10:** `slot-move.24` as worded bars only a move older than the newest its log names; planted that way, a source fences its newest move again and `NoBack` fails in 21 steps. See "After card 0002: the decided form".

The findings and the changes they ask of the ledger are in "Findings", in the sections of the second and third model, and in "Proposals for the ledger". Nothing in the ledger was changed by this study.

## The models

Three TLA+ models, each small enough to run to the end.

| Model | Its world | What only it has |
|---|---|---|
| [SlotMove.tla](SlotMove.tla) | groups as single logs; reports read from committed logs | the whole carried set, the table as a home log, any group down, a membership change, routes and the stall check |
| [SlotMoveMsg.tla](SlotMoveMsg.tla) | the same groups; reports stored | an unclean recovery, the moving epoch, the ready report, the carried set sent early and merged with a delta, the END flag |
| [SlotMoveMembers.tla](SlotMoveMembers.tla) | one group with members | elections, per-member logs, two leaders, a membership change that takes effect on commit, two member faults |

The sections up to "Findings" are about the first model. The second and the third have a section each after it.

## The first model

[SlotMove.tla](SlotMove.tla). A second small module, [SlotMoveStall.tla](SlotMoveStall.tla), adds what the stall check needs. Each line that holds a rule is marked `@rule <id>`. A line that holds a rule of another mechanism the move leans on is marked `@keeps <id>`. An assumption of the world is marked `@world <name>`.

### The move, as the model reads the ledger

1. **The row.** The home group's leader starts a move, one at a time. The target's row goes into the home log. **The row's number is the move's name.** Every later entry of the move carries it.
2. **The early copy.** The target may log copies of the slot's committed records while the source still takes writes. Reads do not see them.
3. **The fence.** The source logs one entry that names the move and the target. It may do so only for a row that has committed in the home log. From the moment the fence is in its log, committed or not, the source takes no write to the slot.
4. **The final copy.** Once the fence has committed, the target logs one entry: the records it does not hold yet, and the carried set as it stood at the fence. When that entry commits, the target serves the slot. There is no other entry.
5. **Giving up.** The target may log an abort at any time before its final copy is in its log. After that it never takes the final copy. It then writes the row back. The source reopens the slot by an entry of its own, on the target's committed abort, and takes writes again once that entry commits.

So the home group is needed before the fence and never between the fence and the open. The window holds two commits in a row: the fence in the source's log and the final copy in the target's *(counted from the model's steps)*. Finding 5 is about that count.

### The world

- **Three groups.** A and B hold data; H is the home group. The slot starts in A. A move goes from A to B; a second move may bring it back.
- **A group is a log and a commit index.** A leader change may drop any part of the uncommitted tail. A dropped tail may come back with a later leader, until the next commit.
- **Two faults.** A group of three voters with two faults has no majority. The model takes it down: it takes nothing and commits nothing until it comes back. Any of the three groups may go down.
- **A membership change** is an entry in the group's own log, between the move's entries. It sets the number of voters. B may start one voter short (a growing group).
- **Messages.** The model stores none. Every report of the move is a fact in some group's committed log, and in this world a committed fact stays true. So a step that needs a report reads the sender's committed log. A lost report is a step that is never taken. A late report is a step taken later. A report that arrives twice is a step that may run twice. The slot table may be read stale: a reader may see any earlier committed state of it.
- **Writers.** Each stream numbers its writes 1, 2, 3 and so on. Copies of every write are always in flight: any write may reach any group at any time, any number of times. The leader takes a write only when it is the next number after the stream's high mark, read at its log end (the take rule of `stream-numbers.4`).
- **Routes** (in the stall check only). A writer sends to the group its route names. A group that does not serve the slot answers `moved` with another group, or `retry`. A route may also go stale by itself.

### The carried set

`slot-move.15` lists it. The model carries each part on its own line, so each can be left behind alone.

| Part | In the model | What breaks without it |
|---|---|---|
| the slot's sequence | the last sequence number | a position names two records (`PosUnique`) |
| the slot's epoch | the epoch number of every position | positions leave the slot's one order (`PosUnique`) |
| the stream table: high marks | one number per stream | a write is applied twice (`Once`) |
| the stream table: kept answers | the answer of every taken write | a repeat gets no first answer (`AnswersKept`) |
| the lock fence table | the highest lock token | a write under an old token lands after a newer one (`TokOrder`) |
| row versions | the row's version: the position of its last applied write | a write sent "only if the row is at version v" is refused when v is right (`VerRight`) |
| the last stamp | the highest writer time; B's clock runs behind A's | the slot's stamps go back (`StampOrder`) |
| caller keys, removal marks, segment and snapshot names | **one token, `rest`** | only the direct check `Whole` |

The last row is the abstract one. Those four parts are carried bytes here: the model has no step that reads them. A caller key (a `once` name) acts as one more stream, so the stream table's two rows speak for it *(reasoned)*.

The epoch never changes in this model: it changes only at an unclean recovery, which the second model has. So the epoch's row here shows that a target must go on in the source's epoch; the second model shows what happens when the epoch moves.

The floors are not here. Probe P5 showed that a floor only bounds memory. The model keeps every answer.

### The properties

Each is an invariant on committed state.

| Name | What it says |
|---|---|
| `PosUnique` | a position (slot, epoch, sequence) never names two records, and the positions are 1, 2, 3, ... with no hole |
| `Once` | no write is applied twice |
| `InOrder` | each stream's writes are committed in order with none missing: by position its numbers are 1, 2, 3, ... |
| `OneServer` | at most one group serves the slot's writes: at most one committed log holds the slot open |
| `OneTaker` | the same at the log ends, where a leader takes writes: at most one group's log, tail included, holds the slot open |
| `Views` | no write is lost and reads never see the slot go back: what any group shows is the first part of the slot's one history, and the group that serves shows all of it |
| `CopyTrue` | an early copy holds only committed records, in order |
| `AnswersKept` | the group that serves holds the first answer of every committed write |
| `TokOrder` | a write under an older lock token never lands after one under a newer token |
| `StampOrder` | the slot's stamps never go back |
| `VerRight` | a write sent "only if the row is at version v" is applied exactly when the row was at v |
| `TableRight` | the table is never behind an open: a served slot's row names its server, or names the target of a move that has not opened; a committed final copy has its row; with `BackFirst`, a committed reopen has its row written back |
| `RowFirst` | every entry of a move, in any log, names a move whose row has committed |
| `OpenFull` | no slot opens in a group with fewer voters than the copies setting |
| `Whole` | the target opens only with every part: a committed final copy holds the source's records and its whole carried set as they stood at the fence |

"Routes converge" is not an invariant. It is the stall check below.

### The reach checks

A model that can do nothing is safe. So four goals must be reachable. Each is written as "the goal is never reached", and the run must fail.

| Bound | The goal |
|---|---|
| `r-moved` | a move completes, the target takes a write, and every write has committed |
| `r-back` | a move is given up, and the source takes a write again |
| `r-twice` | the slot moves to B and back to A, and every write has committed |
| `r-hard` | a move completes and every write commits, where the fence is logged while the home group is down, the home group never returns, a membership change committed in the source before the fence and in the target before the final copy, some data group lost its majority and came back, and a leader changed |

### The stall check

A safety check cannot see a slot that is stuck. The stall check can. TLC prints the whole state graph of a small bound, and [stall.py](stall.py) asks of every reachable state where both data groups have a majority:

- with the home group up: is there a path of protocol steps, with no fault, to a state where every write has committed? And to one where the table also names the group that serves?
- with the home group down, and staying down: is there such a path to a state where every write has committed?

The first is "routes converge": whatever a writer's route says, it can still land its writes. The second is "the home group down does not block the slot" (GROUPS H4; V5-18 pick 6). The study's earlier models asked the same kind of question (E-15's property 7).

## Bounds and results of the first model

One box, 4 cores, 15 GB, shared with other jobs. TLC2 2026.11.19 on Java 21, 2 workers, a 4 GB heap. Every run below is complete: every reachable state at its bound *(checked; states and times measured)*. Times are wall-clock beside other jobs, so read them as rough.

**The small bounds.** Each adds one thing to the smallest world.

| Bound | Streams x writes | Moves | Leader changes | Times a group is down | Membership changes | Early copies | Also | Result | Distinct states | Depth | Time |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `core` | 1 x 2 | 1 | 0 | 0 | 0 | 0 |  | pass | 113 | 15 | 2 s |
| `crash` | 1 x 2 | 1 | 2 | 0 | 0 | 1 |  | pass | 4,322 | 20 | 3 s |
| `bulk` | 1 x 3 | 1 | 1 | 0 | 0 | 2 |  | pass | 10,475 | 23 | 6 s |
| `twice` | 1 x 2 | 2 | 1 | 0 | 0 | 1 |  | pass | 16,092 | 29 | 9 s |
| `lock` | 2 x 1 | 1 | 1 | 0 | 0 | 1 | lock tokens | pass | 2,436 | 19 | 3 s |
| `ver` | 1 x 2 | 1 | 1 | 0 | 2 | 0 | "only if at version v", B starts a voter short | pass | 46,291 | 22 | 13 s |
| `ver2` | 2 x 2 | 1 | 0 | 0 | 0 | 0 | "only if at version v" | pass | 987 | 19 | 3 s |
| `lazy` | 1 x 2 | 2 | 1 | 1 | 0 | 0 | the reopen does not wait for the row | pass | 23,780 | 29 | 9 s |
| `down` | 1 x 2 | 1 | 1 | 1 | 1 | 1 |  | pass | 176,840 | 23 | 34 s |

**The big bounds.** The same things together, and more of each.

| Bound | Streams x writes | Moves | Leader changes | Times a group is down | Membership changes | Early copies | Also | Result | Distinct states | Depth | Time |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `big-two` | 1 x 2 | 2 | 2 | 0 | 0 | 2 |  | pass | 66,703 | 33 | 22 s |
| `big-lock` | 2 x 1 | 2 | 2 | 1 | 0 | 1 | lock tokens | pass | 233,670 | 32 | 37 s |
| `big-three` | 1 x 3 | 2 | 2 | 0 | 0 | 2 |  | pass | 323,359 | 34 | 71 s |
| `big-faults` | 1 x 2 | 1 | 2 | 1 | 1 | 1 |  | pass | 710,725 | 25 | 121 s |
| `big-streams` | 2 x 2 | 2 | 1 | 0 | 0 | 1 |  | pass | 758,790 | 33 | 176 s |
| `big-all` | 1 x 2 | 2 | 1 | 1 | 1 | 1 |  | pass | 1,658,720 | 33 | 392 s |
| `big-lazy` | 1 x 2 | 2 | 1 | 1 | 1 | 1 | the reopen does not wait for the row | pass | 2,120,860 | 33 | 266 s |
| `big-ver` | 1 x 2 | 2 | 2 | 1 | 2 | 0 | "only if at version v", B starts a voter short | pass | 8,001,160 | 37 | 1201 s |

In all 17 safety bounds, 14,155,323 distinct states, every property holding on each. The longest run took 1201 s (20 minutes), inside the hour.

**The reach checks.** The run ends at the first state that meets the goal, so the counts are small. They also change a little from run to run.

| Bound | Streams x writes | Moves | Leader changes | Times a group is down | Membership changes | Early copies | Also | Result | Distinct states | Depth | Time |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `r-moved` | 1 x 2 | 1 | 0 | 0 | 0 | 1 |  | goal reached | 218 | 11 | 2 s |
| `r-back` | 1 x 2 | 1 | 0 | 0 | 0 | 0 |  | goal reached | 110 | 14 | 2 s |
| `r-twice` | 1 x 2 | 2 | 0 | 0 | 0 | 0 |  | goal reached | 502 | 18 | 2 s |
| `r-hard` | 1 x 2 | 1 | 1 | 2 | 2 | 1 | B starts a voter short | goal reached | 1,269,447 | 19 | 73 s |

**The stall checks.** One stream; a writer follows its route. "Stuck" counts the states, among those where both data groups have a majority, from which no path of protocol steps reaches the goal.

| Bound | Writes | Moves | Leader changes | Times a group is down | Membership changes | Also | States | Home up: the writes can finish | Home up: and the table names the server | Home down: the writes can finish without it |
|---|---|---|---|---|---|---|---|---|---|---|
| `s-strict` | 1 | 1 | 1 | 1 | 1 | B starts a voter short | 33,440 | 0 stuck of 13376 | 0 stuck of 13376 | 998 stuck of 6688 |
| `s-lazy` | 1 | 1 | 1 | 1 | 1 | B starts a voter short, the reopen does not wait for the row | 40,000 | 0 stuck of 16000 | 0 stuck of 16000 | 0 stuck of 8000 |
| `s-twice` | 1 | 2 | 0 | 1 | 0 | the reopen does not wait for the row | 4,200 | 0 stuck of 1680 | 0 stuck of 1680 | 0 stuck of 840 |

In the table, "s-strict: stall" is the wanted result: that bound is Finding 2.

**A dropped tail can come back only where a bound allows 2 leader changes**: the coming back is the second change. Those are `crash`, `big-two`, `big-lock`, `big-three`, `big-faults` and `big-ver`.

**One bound is not counted.** `deep-faults.cfg` (2 leader changes, a group down twice, 2 membership changes, 2 early copies, one move) was stopped by hand after 13 minutes, at 7,134,884 distinct states with 2,727,977 still waiting, at depth 17 *(measured)*. No property had failed in the part explored. That is not a pass. `run.sh` does not run it unless it is named. The same faults with one of each less are `big-faults`, which is complete.

## Findings

### Finding 1: when has a move ended?

`move-policy.4` says the home group's leader starts one move at a time. It does not say when the last move is over.

The first version of the model let the next move start once the last one's abort had committed. Bound `twice` then broke `TableRight` in 11 steps *(checked)*:

1. The home group starts move 1, A to B. Its row commits.
2. B gives move 1 up before any fence. The abort commits. The row is not yet written back, so the table still names B.
3. The home group starts move 2. It reads its table, sees B, and so makes it a move from B to A. Its row commits.
4. A gives move 2 up. It writes the row "back" to the source the row names: B.
5. The table now names B at its highest version. A serves the slot and was never fenced. No later step corrects it.

The fix in the model: a move has ended only when its final copy has committed, or its row has been written back. Both are facts the home group can know: the second is in its own log. With that, every bound holds. The old reading is kept as planted mistake `t06`; it is caught.

### Finding 2: giving up while the home group is down

`slot-table.5` says the target writes the row back before the source reopens. The row goes into the home log. So a give-up needs the home group.

The stall check on bound `s-strict` shows what that costs: 998 of the 6,688 states with the home group down are stuck *(checked)*. The shortest way in is four steps: the row commits, the source fences, the home group goes down, and the target is one voter short, so it may not open (`slot-move.22`). The target can only give up, and the source cannot reopen until the home group returns. The slot takes no writes at either group for the whole outage. A target that gives up on its timer for any other reason gets there too.

Bound `s-lazy` is the same world with one change: the source reopens on the target's committed abort alone, and the row is written back when the home group answers. There, 0 of the 8,000 states with the home group down are stuck *(checked)*. Every safety property holds in that form too, on bounds `lazy` and `big-lazy` *(checked)*. What changes is what the table may say: for a while it names a target that gave up. `TableRight` allows that already: it names the target of a move that has not opened. Such a target answers `moved` with the source from its own abort entry, so a writer still finds the slot (the stall check's first two rows).

So the ledger has a choice to make, and it is the owner's kind of choice (V5-18 pick 6 lets a target "that never wrote the slot" give up without the home group; with the row written first there is no such target):

- **keep `slot-table.5` as it is**: the table is exact whenever a slot is served, and a slot whose move is given up while the home group is down waits for the home group; or
- **let the reopen go first**: no slot waits for the home group after its fence, and the table may name a target that gave up until the home group is back.

### Finding 3: the row comes before the fence, and `slot-move.21` has nothing to act on

The ledger says the target writes the row "before it serves the slot" (`slot-table.4`). It does not say whether that is before the fence or inside the window.

- **Inside the window** the window holds three commits, one of them in the home group: the fence, the row, the final copy. That is the three-commit window V5-18 pick 4 cut. And a home group that goes down inside the window blocks the open *(reasoned)*.
- **Before the fence** the window holds the fence and the final copy, and nothing after the fence needs the home group to go forward. This is the model's reading. `RowFirst` holds on every bound: every fence, final copy, abort and reopen names a move whose row has committed *(checked)*.

With the row before the fence, a target "that has not written the slot's table row" never meets a fence. So `slot-move.21` never applies, and the clause "only if the target had written the row" in `slot-table.5` is always true *(checked, as a consequence of `RowFirst`)*. What `slot-move.21` was written for, a give-up that does not wait for the home group, is Finding 2's second form.

### Finding 4: the source must fence a move only once

The ledger says the target takes a move's final copy only once (`slot-move.8`). It has no such rule for the source. The model needs one.

Take the rule away, so that a source may fence a move a second time (planted mistake `m22`). The slot moves from A to B and back to A. Then A acts on an old report of move 1: in the model, an old state of the table. It fences move 1 again. B already holds move 1's final copy, so it can neither take it again (`slot-move.8`) nor abort (`slot-move.17`). Nothing can ever open the slot: it stays fenced for good, in 13 steps *(checked: the stall check on `s-twice`; [results/finding4-stall.txt](results/finding4-stall.txt))*. No safety property sees it, because nothing wrong is written.

The model's rule: the source never fences a move whose fence its log already holds. A real log is cut behind snapshots, so the real rule needs the fact kept with the slot's state: the newest move the group has taken part in *(reasoned)*.

### Finding 5: as written, the window holds two commits, not one

The record calls this form the one-commit move, and it rests the 10 ms bar on a window of one commit: E-13 timed one commit at 4.56 ms and two at 12.77 ms at p99 under 10,000 writes a second *(measured there)*.

In the ledger's words the window holds two. The source stops at its fence. The fence must commit before the final copy is sent (`slot-move.4`). Then the final copy must commit before the target takes a write: "that entry's commit opens the slot" (`slot-move.7`), and a group takes a write only for a slot its committed log holds open (`slot-table.1`). The model has exactly these two commits between the last write at the source and the first at the target *(counted from the model's steps)*. How long they take is not this study's to say (GROUPS 4.3 row 7).

The model also shows the way to one. Let the target's leader take writes as soon as the final copy is in its log, before it commits. Each such write sits behind the final copy in the same log. So it can only commit after it, and a writer's answer waits for its own write's commit, as always. Planted mistake `k01` is this change. It is not caught: every property holds on the small bounds, the reach goals stay reachable and the stall checks find nothing; and in a run of its own on `twice`, `lazy`, `down`, `big-streams` and `big-all`, every property holds again, over 17,008, 27,180, 185,655, 828,616 and 1,757,820 states ([results/k01-runs.txt](results/k01-runs.txt)) *(checked)*. `OneTaker` is the property that speaks for it: at most one group's log, tail included, holds the slot open.

What the model does not have is a read from a log's tail. A read served by the target before the final copy commits could show records that a leader change then drops. So the change is for writes only: reads and answers still wait for the commit *(reasoned)*.

### Smaller findings

- **The move's name.** `slot-move.3` says the fence names "the move". No record says what a move's name is. The fused probe named a move by its fence's place in the source's log; with the row written first there is no fence yet. The model names a move by its row's number in the home log, and every bound holds with it *(checked)*.
- **What a target answers before the fence.** With the row written first, the table names the target while the source still serves. A writer that reads the table then goes to the target and is told `retry` (`slot-move.9`) until the move opens or is given up. So the target should write the row late: after its early copy, just before it tells the source it is ready *(reasoned; the model lets the copy and the row come in either order)*.
- **Who may give up before the fence.** `slot-move.16` and `slot-move.17` split giving up in two: before the fence only the source, after it only the target. In the model the target may abort at any time before its final copy, before the fence too, and the source has no step of its own for dropping a move: it simply does not fence. Every bound holds *(checked)*. So "only the source" is not a safety rule in this form.

## The second model: stored reports, a recovery, the early carried set

[SlotMoveMsg.tla](SlotMoveMsg.tla). Bounds `msg-*.cfg`.

### Why a second model

The first model reads every report from a committed log. That is sound only while a committed fact stays true. An **unclean recovery** breaks it: the operator's recover command (`recover.1` to `.3`) restarts a group that lost its majority from the copies that answer, and entries that had committed may be gone. So this model stores the reports.

- **A report is a stored fact.** When a fence, an abort, a final copy or an early copy commits in a data group, the model writes its report down. A step may read a report at any later time, any number of times, or never. That is a late, a repeated and a lost message. A report stays readable after the group that made it has been recovered: it is a true report of that group's past.
- **A recovery.** A data group's log becomes any part of its committed log. Its tail is gone. Its **incarnation** (the number of its lives, kept in its record in the home log, `meta-directory.2`) goes up by one. The slot is shut in that group until a rule reopens it.
- **The epoch moves.** A slot's position is (epoch, sequence). A reopen after a recovery is in a new epoch. The home log hands epochs out: every new one is one above the highest in the table's rows.
- **The home log** is its committed rows only, and it may be down. A home group does not have an unclean recovery here.
- **The ready report and the early carried set.** An early copy holds the slot's records and its carried set up to a place in the source's committed log. When the copy commits, the target's report "ready, at place p" exists (`slot-move.12`). The fence names a **base**: a reported place, or "send everything". The final copy then brings only the records after the base and the **delta**: what changed in the carried set since. The target merges the delta onto the early copy it holds (`slot-move.13`).
- **The END flag.** Only a final copy carries it (`slot-move.14`). The model offers the target early-copy messages too, at the step that takes a final copy; the flag is what keeps them out.

Left to the first model: lock tokens, row versions, stamps, the membership change, a data group with no majority, routes. The carried set here is the sequence, the epoch, the high marks, the kept answers, and the one token `rest`.

### The rules a recovery needs

**Finding 6.** The ledger has one rule for a recovery and the slot: "A recovery writes the slot's row at the slot's new epoch" (`slot-table.7`). That is not enough. The older three-commit model needed five more rules (E-15). This one-commit form, with the row written first and the table in the home log, needs the nine rules below *(checked)*. Each is a marked line with a planted mistake, and the last column says what fails without it.

| # | The rule | Mark in the model | Without it |
|---|---|---|---|
| R1 | A move's row names the incarnation of both groups, as the home log holds them when the row is written. A group fences, copies or takes a final copy for a move only while it is in that life. | `row.inc` | `u06`, a recovered target takes a final copy ordered for its old life: `TableRight` in 10 steps. `u03`, `u04`, a row that does not hold them: a recovered group can never take part in a later move (reach). The source's half (`u05`) and the early copy's (`u07`) are not caught: R2 and R9 already stop a recovered source, and an early copy alone opens nothing |
| R2 | After a recovery the slot is shut in that group. Only a recovery row reopens it. | `recover.shut`, `recover.row` | `u01`: two groups serve in 2 steps (`OneServer`). `u22`, a reopen on an older life's row: `NoBack` in 10 steps |
| R3 | The home group's leader gives a recovered group its row only if the table names that group and the group's copy holds the final copy of the last move into it. | `recover.table`, `recover.final`, `recover.copy` | `u19`: `TableRight` in 8 steps. `u20`: `TableRight` in 9 steps. The third line, "its copy holds the slot" (`u18`), is not caught: the other two imply it |
| R4 | The recovery row has a new epoch, and the group reopens in it (`slot-table.7`). | `slot-table.7`, `recover.epoch` | `u21`, `u23`: reads see the slot go back inside one epoch, 7 steps (`NoBack`) |
| R5 | A target that gives a move up in another life than the row names says so: its old life's records may be lost. | `abort.lost` | `u09`: `NoBack` in 14 steps |
| R6 | For such a give-up, if the table still has the slot at that target by that move, the home group writes the row back as a new row: above every other row, at a new epoch. | `back.lost`, `back.epoch` | `u10`: `NoBack` in 14 steps. `u14`, not above the later rows: `TableRight` in 16 steps. `u11`, `u13`, the two halves of "still has the slot there by that move": `TableRight` in 20 steps, `NoBack` in 15. `u15`, the old epoch: `NoBack` in 14 steps |
| R7 | After such a give-up the source reopens only once that row is written, and in its epoch. | `unf.wait`, `unf.epoch` | `u16`: `NoBack` in 14 steps. `u17`: the reopen has no row to read its epoch from, and the model stops |
| R9 | A group never fences, and never takes a final copy, for a move older than the newest row its log names. | `fence.newer`, `final.newer` | `u24`: positions go back in 24 steps (`InOrder`). `u26`: two groups hold the slot open in 20 steps (`OneTaker`) |
| R10 | A group that holds the slot open takes no final copy for it. | `final.shut` | `u25`: `NoBack` in 19 steps |

There is no R8. The model's first form had one more rule, "a move whose target has had a new life has not ended by its final copy". Its line is still marked (`ended.inc`), and the planted mistake on it is not caught: R6 covers it.

How these sit beside E-15's five fixes *(reasoned from the two rule lists)*: R1 is E-15's fix 4 (the fence binds the target's incarnation), made simpler by the home log, which knows both incarnations when it writes the row. R2 and R3 are fix 1 (a recovered group ends its part) and the recovery rule. R4 is fix 3, the ledger's `slot-table.7`. R5 to R7 are fix 5 (reopen in the new epoch). E-15's fix 2 (row versions by move, life and step) is `slot-table.6`; see "The table's order" below. R9 and R10 are new: they come from moves that follow one another, which E-15's bounds had less of. **Finding 7** is R9: it is Finding 4's rule in a strong form, on both sides.

**What a recovery costs a slot.** After a recovery some states have no way forward without the operator: for example, a target that lost its final copy while the table has moved on. The model makes no promise there. It checks that nothing wrong is served, not that the slot is served again. Two reach checks show the two good ends: the source reopens in a new epoch after a lost target, and a recovered group reopens by its own row.

**Finding 2 gets an exception.** Finding 2 offers a form where the source's reopen does not wait for the home group. R7 is the case where it must: after a lost target, the reopen needs the new epoch, and only the home log hands one out *(checked: `u16`, `u17`)*.

### The table's order

`slot-table.6` says the table keeps the highest version of a row. In the first model the planted mistake on it (`t04`: the last row written wins) is not caught, because rows are written there in version order. Here it is caught: `u51` breaks `TableRight` in 16 steps *(checked)*. A row written back late for an older move lands after the new row of R6, and must lose to it. So `slot-table.6` earns its place exactly through a recovery.

The version in this model is the row's number, then its step. A move's row takes the next number. Its written-back row keeps the number and has a higher step. A recovery's row and R6's row take the next number. The home group's leader gives the numbers, from its own log *(the model's reading; no record says what a row's version is)*.

### The early carried set

**Finding 8.** The delta is cut at a base, and the target must hold exactly that base. The ledger's `slot-move.13` says a small delta crosses the window; it does not say from where.

- The source cuts the records and the carried set's delta at the place the ready report named.
- The target takes the final copy only if its early copy stands at that place (`delta.base`). If the place differs, it does not open; it can only give the move up.
- The merge takes the sequence and the epoch from the delta, each stream's higher mark, both sets of kept answers, and the byte parts from either side.

Every planted mistake on the delta's and the merge's lines is caught (`u28` to `u41`, 14 of 14), and so are the two on the END flag and the ready report. One more, on the order of early copies, is harmless *(checked)*:

- a delta merged onto a copy that stands at another place (`u28`): a record is applied twice, 12 steps (`InOrder`);
- a delta cut at the wrong place (`u29`, `u30`): 10 steps;
- a mark, an answer, the sequence, the epoch or the byte parts left out of the delta or dropped by the merge (`u31` to `u41`): the group that serves judges by the wrong state, 6 to 10 steps (`StateRight`, `Whole`);
- an early copy taken for the final copy (`u27`, the END flag): two groups hold the slot open in 3 steps;
- a later early copy that stands before an earlier one (`u43`): not caught. The base check makes it harmless: the target can then only give the move up.

`slot-move.12` has two halves. "The target reports the place its copy reached" is needed: with a wrong place in the report no move with an early copy completes (`u42`). "The source fences only after that report" is a speed rule: the model lets a source fence with no report and send everything, and every property holds (bounds without `NeedReady`) *(checked)*.

### Properties

| Name | What it says |
|---|---|
| `PosUnique` | a position (epoch, sequence) never names two records, lost records counted: every record that ever committed is kept for this check, with the group life that stamped it |
| `OneServer`, `OneTaker` | at most one group holds the slot open, in its committed log and at its log end |
| `InOrder` | what any group shows is in order: each stream's numbers are 1, 2, 3, ... with no write twice, and positions only rise |
| `StateRight` | the group that serves judges by the right state: its sequence, each high mark, the kept answers and the byte parts match its records |
| `NoLoss` | while no recovery has happened, the server shows every write that ever committed |
| `NoBack` | reads never see the slot go back inside one epoch: the view a server shows extends the last served view, or the epoch is higher |
| `TableRight` | a served slot's row names its server, or names the target of a move from it; every epoch a group serves in is known to the home log; every entry of a move names a row |
| `Whole` | a committed final copy holds the source's records and whole carried set as they stood at the fence |

### Bounds and results

Same box and tools as the first model. Every run is complete *(checked; states and times measured)*.

**The small bounds.**

| Bound | Streams x writes | Moves | Leader changes | Recoveries | Early copies | Home group down | Also | Result | Distinct states | Depth | Time |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `msg-core` | 1 x 2 | 1 | 0 | 0 | 0 | 0 |  | pass | 92 | 13 | 1 s |
| `msg-early` | 1 x 2 | 1 | 0 | 0 | 2 | 0 | the fence waits for a ready report | pass | 356 | 17 | 1 s |
| `msg-crash` | 1 x 2 | 1 | 1 | 0 | 1 | 0 |  | pass | 804 | 17 | 2 s |
| `msg-rec` | 1 x 2 | 1 | 0 | 1 | 0 | 0 |  | pass | 1,406 | 21 | 2 s |
| `msg-rec-early` | 1 x 2 | 1 | 0 | 1 | 1 | 0 |  | pass | 7,624 | 23 | 4 s |
| `msg-rec-crash` | 1 x 2 | 1 | 1 | 1 | 0 | 0 |  | pass | 2,812 | 23 | 2 s |
| `msg-rec-down` | 1 x 2 | 1 | 0 | 1 | 0 | 1 |  | pass | 4,218 | 23 | 3 s |
| `msg-rec-twice` | 1 x 2 | 2 | 0 | 1 | 0 | 0 |  | pass | 18,967 | 30 | 8 s |
| `msg-rec-lazy` | 1 x 2 | 2 | 0 | 1 | 0 | 0 | the reopen does not wait for the row | pass | 21,030 | 30 | 8 s |
| `msg-rec-three` | 1 x 1 | 3 | 0 | 1 | 0 | 0 |  | pass | 83,688 | 36 | 33 s |
| `msg-rec2` | 1 x 1 | 2 | 0 | 2 | 0 | 0 |  | pass | 150,732 | 32 | 39 s |

**The big bounds.**

| Bound | Streams x writes | Moves | Leader changes | Recoveries | Early copies | Home group down | Also | Result | Distinct states | Depth | Time |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `msg-big-three` | 1 x 2 | 3 | 0 | 1 | 0 | 0 |  | pass | 240,077 | 40 | 95 s |
| `msg-big-early` | 1 x 2 | 2 | 1 | 1 | 2 | 0 | the fence waits for a ready report | pass | 1,162,414 | 39 | 341 s |
| `msg-big-all` | 2 x 1 | 1 | 1 | 1 | 1 | 1 |  | pass | 103,602 | 27 | 23 s |
| `msg-big-rec` | 1 x 2 | 2 | 1 | 2 | 0 | 0 |  | pass | 1,018,412 | 40 | 333 s |
| `msg-deep-all` | 2 x 1 | 2 | 1 | 1 | 1 | 1 |  | pass | 6,480,516 | 38 | 2043 s |

In all 16 safety bounds, 9,296,750 distinct states, every property holding on each. The longest run took 2043 s. This model is slow per state: every state carries its stored reports.

**The reach checks.**

| Bound | Streams x writes | Moves | Leader changes | Recoveries | Early copies | Home group down | Also | Result | Distinct states | Depth | Time |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `msg-r-early` | 1 x 3 | 1 | 0 | 0 | 1 | 0 | the fence waits for a ready report | goal reached | 368 | 16 | 1 s |
| `msg-r-lostback` | 1 x 2 | 1 | 0 | 1 | 0 | 0 |  | goal reached | 921 | 13 | 2 s |
| `msg-r-reopen` | 1 x 2 | 1 | 0 | 1 | 0 | 0 |  | goal reached | 326 | 9 | 2 s |
| `msg-r-oldreport` | 1 x 2 | 1 | 0 | 1 | 0 | 0 |  | goal reached | 569 | 11 | 1 s |
| `msg-r-aftersrc` | 1 x 2 | 1 | 0 | 1 | 0 | 0 |  | goal reached | 989 | 14 | 2 s |
| `msg-r-afterdst` | 1 x 2 | 1 | 0 | 1 | 0 | 0 |  | goal reached | 584 | 11 | 2 s |

- `msg-r-early`: a move completes from an early copy that held a record, with a delta that brought a record, and the target takes a write.
- `msg-r-lostback`: the target is recovered after it opened; the source reopens in a new epoch and takes a write.
- `msg-r-reopen`: a recovered group reopens the slot by its own row and takes a write.
- `msg-r-oldreport`: the source is recovered and loses its fence; the target still opens, on the old life's report, and takes a write.
- `msg-r-aftersrc`, `msg-r-afterdst`: a recovered group takes part in a later move, as its source and as its target.

**The largest bound, `msg-deep-all`,** has everything at once: two streams, two moves, a recovery, a leader change, an early copy, the home group down. A first try of it, beside six other runs, was stopped by hand after 17 minutes at 1,400,043 distinct states, and was not counted. The run in the table is a second one, with the box less busy: it ended in 34 minutes, inside the hour *(measured)*. It keeps its first name. `msg-big-all` is the same world with one move.

**Failures on the way.** The model's first form had R1, R2, R4, R5, R7 and a plain R3, written from E-15's fixes. Then runs failed on `msg-rec-twice`, `msg-big-three` and `msg-big-rec`, and each failure added a rule or sharpened one *(checked)*:

- the table named a group that did not serve, 16 steps: R6;
- a view went back, 19 steps: R10;
- positions went back, 24 steps: R9 for the fence;
- two open groups, 20 steps: R9 for the final copy;
- positions went back, 18 steps: R9 also counts a recovery's row;
- the table named a group that did not serve, 18 steps: a clause of R6 against the target's own recovery row. The next fix made that clause spare (`u12`);
- two open groups, 20 and 22 steps: R3's "the final copy of the last move into it".

One failure was the property's, not a rule's: the first `TableRight` asked that the table's epoch equal the epoch served. A give-up by a recovered target before any fence raises the table's epoch while the source never stopped. The property now asks that every epoch served is known to the home log. The mistakes `u09` to `u26` bring each of the rule failures back.

## The third model: a group with its members

[SlotMoveMembers.tla](SlotMoveMembers.tla). Bounds `mem-*.cfg`.

### The question

The record's K-01: does the move hold when it meets a membership change and two member faults? The earlier crossing model (E-32) had one member fault, a configuration that took effect at every member at once, and no election that met a voter behind the log.

### What the model is

One of the two data groups has members. The other stays one log, as in the first model. The slot table is left out: one move, from A to B, is under way from the start.

- **A member** has its own log, its own term and its own commit index. It fails and comes back with its disk.
- **An election** is one step: a candidate wins when a majority of its own configuration grants, and a member grants only to a candidate whose log is not behind its own.
- **A leader** hands a member its whole log in one step. It learns that an entry is committed when a majority of its configuration holds it and the entry is of its own term.
- **A membership change** is an entry: one voter more or one voter less. A member uses the newest configuration in the part of its log it knows to be committed (`raft-config.13`).
- **Two leaders.** A leader that the others have voted past still acts on its own log until it hears of the new term.
- **A new leader does not know yet what is committed.** Its commit index may be behind.
- **Reports.** A report of a commit may come from any member, alive or not, about what that member knows to be committed.

The move's guards are read as a leader can read them: "its committed log" is the part of its own log it knows to be committed, and "its log" is its own log, tail included.

These Raft steps are short forms, marked `@keeps` with the ledger's Raft records. The Raft port has its own proof (probe P1). This model does not prove Raft. It checks that the move's rules, read by one leader from its own log, need nothing more from the group than those records give.

### Properties

`RaftSafe`: what the members know to be committed never disagrees. Then the first model's `PosUnique`, `Once`, `InOrder`, `OneServer`, `Views`, `Whole` and `OpenFull`, read on the real group's committed log: the longest part any member knows to be committed.

### Bounds and results

Same box and tools. Every run is complete *(checked; states and times measured)*. The three first voters are alike, so TLC checks one of each set of states that differ only by their names (symmetry).

**The small bounds.**

| Bound | The group with members | Members (first voters) | Terms | Member faults | Membership changes | Result | Distinct states | Depth | Time |
|---|---|---|---|---|---|---|---|---|---|
| `mem-src-core` | the source | 3 (3) | 1 | 0 | 0 | pass | 948 | 17 | 2 s |
| `mem-dst-core` | the target | 3 (3) | 1 | 0 | 0 | pass | 678 | 15 | 2 s |
| `mem-dst-grow` | the target | 3 (2) | 1 | 0 | 1 | pass | 6,710 | 19 | 3 s |
| `mem-dst-shrink` | the target | 3 (3) | 1 | 0 | 1 | pass | 6,391 | 18 | 2 s |
| `mem-src-fault` | the source | 3 (3) | 2 | 1 | 0 | pass | 134,665 | 22 | 13 s |
| `mem-dst-fault` | the target | 3 (3) | 2 | 1 | 0 | pass | 75,281 | 20 | 9 s |
| `mem-src-cfg` | the source | 4 (3) | 1 | 0 | 1 | pass | 153,112 | 25 | 18 s |
| `mem-src-cfg2` | the source | 3 (3) | 2 | 0 | 2 | pass | 189,684 | 24 | 17 s |

`mem-dst-grow` starts the target one voter short, with a third member to add. `mem-dst-shrink` and `mem-src-cfg` have a voter to remove or to add. `mem-src-cfg2` has two membership changes and no writes.

**The big bounds: K-01's world.**

| Bound | The group with members | Members (first voters) | Terms | Member faults | Membership changes | Result | Distinct states | Depth | Time |
|---|---|---|---|---|---|---|---|---|---|
| `mem-src-two` | the source | 3 (3) | 2 | 2 | 1 | pass | 4,969,277 | 27 | 922 s |
| `mem-dst-two` | the target | 3 (3) | 2 | 2 | 1 | pass | 2,133,498 | 25 | 311 s |

In all 10 safety bounds, 7,670,244 distinct states, every property holding on each. The longest run took 922 s.

**The reach checks.**

| Bound | The group with members | Members (first voters) | Terms | Member faults | Membership changes | Result | Distinct states | Depth | Time |
|---|---|---|---|---|---|---|---|---|---|
| `mem-src-r` | the source | 3 (3) | 1 | 0 | 0 | goal reached | 616 | 9 | 1 s |
| `mem-dst-r` | the target | 3 (2) | 1 | 0 | 1 | goal reached | 5,486 | 14 | 2 s |
| `mem-r-two` | the source | 3 (3) | 2 | 2 | 1 | goal reached | 2,179,104 | 15 | 114 s |

`mem-r-two` is the asked one: the move completes and every write commits, with two member faults, a committed membership change, a second election, and an election that met a voter whose log was behind what another member knew committed.

**One bound is not counted.** `mem-deep-four.cfg` (four members: three voters and a spare; two faults, two terms, one membership change) was stopped by hand after 8 minutes, at 2,926,254 distinct states with 1,869,239 still waiting, at depth 12 *(measured)*. No property had failed. That is not a pass. The complete K-01 bounds have three members. An earlier try of `mem-src-two` beside six other runs was killed by the kernel for lack of memory; the counted run is a later one, alone.

### What it shows

- **K-01 holds at these bounds.** With two member faults, a second election, an old leader that still acts, a new leader behind on what is committed, and a membership change in the group that fences or in the group that opens, every property holds *(checked)*.
- **Finding 9: which configuration `slot-move.22` reads.** The rule says no slot opens in a group with fewer voters than the copies setting. A leader has two configurations in hand: the one it knows committed, and the newest in its log. The model's rule reads the newest in the log. Planted mistake `n09` reads the committed one: the leader logs "one voter less", then the final copy, both commit, and the slot has opened in a group of two voters, in 10 steps (`OpenFull` on `mem-dst-shrink`) *(checked)*. Reading the log end is also enough when a voter is added: an "added" entry before the final copy commits before it.
- **A guard on the committed log beside a guard on the log end is still spare with members.** The first model could not tell whether `slot-table.1`, `slot-move.2` and the "fence committed" half of `slot-move.19` are needed, because in one log an entry commits only after the entries before it. Here a leader may be an old one, or a new one that does not know yet what is committed. The three mistakes (`n03`, `n04`, `n12`) are still not caught *(checked)*. So the guard on the leader's own log end carries the safety; the guard on the committed log does not add to it at these bounds. That is one more reason to look at Finding 5's one-commit window.
- **The move leans on six Raft rules that the model can show**: the vote's log check and term check, the candidate's own majority, the commit's majority, the hand-over only from a leader whose term is not behind, and the new leader's own entry (`n17` to `n20`, `n22`, `n29`). Without any of them a move's property fails or the move cannot complete.

## Planted mistakes

[mutants.txt](mutants.txt) lists one-line mistakes on the marked lines: drop a guard, flip a comparison, drop or weaken an update, read the wrong place. [mutate.py](mutate.py) plants each one in a copy of the model and runs the small bounds, the reach checks and the stall check. The safety bounds run first without `Whole`, so that a caught mistake names the end property it breaks, not only "the copy differs from the source". The full table is [results/mutants.md](results/mutants.md).

| Group | Planted | Caught |
|---|---|---|
| First model: the move's own entries and guards (ids m) | 23 | 21 |
| First model: the carried set, one part at a time (ids c) | 8 | 8 |
| First model: the slot table in the home log (ids t) | 8 | 7 |
| First model: rules of other mechanisms the move leans on (ids k) | 7 | 6 |
| **First model** | **46** | **42 (91 %)** |
| **Second model** (ids u): the recovery's rules, the delta and the merge, the move's guards again | **56** | **48 (86 %)** |
| Third model: the move's guards as a leader reads them (ids n01 to n16) | 16 | 12 |
| Third model: the Raft rules the move leans on (ids n17 to n29) | 13 | 6 |
| **Third model** | **29** | **18 (62 %)** |
| **All three** | **131** | **108 (82 %)** |
| Probes in the first model: changes the model says are harmless (ids x) | 3 | 0, as expected |

All *(measured)*. The study's bar is 85 %. The first and the second model reach the bar. The third does not, and the three together are just under it. The reasons are below; they are limits of the third model's short form of Raft, and one kind of spare guard that all three models agree on. One mistake's runs took 1 s to 254 s in all; no single run came near the hour.

For the second and the third model, `mutate.py` runs a mistake on the bounds whose world can show it (the lists are at the top of the script), then on the reach checks, then on the slower bounds. Most of the second model's mistakes were run before its check `InOrder` was made stronger ("the i-th record holds sequence i"); the nine that had not been caught were run again after it, and one of them (`u56`) was then caught *(measured)*. A stronger check can only catch more, so the others stand.

The lists below are for the first model. The second and the third model's are after them.

**Not caught, and why.** Three of the four are the same case: a guard on the committed log that sits beside a guard on the log end. In one log an entry commits only after the entries before it, so the second guard never decides alone here. The older model found the same (E-15: a target that serves on an `open` that has not committed is not caught).

- **`m04`, `slot-move.2`**: the source fences a slot its committed log does not hold open. The fence's other guard, on the log end, still holds; an open that is only in the tail sits before the fence and commits first.
- **`m15`, `slot-move.19`** (the fence has committed): the source reopens on a fence still in its tail. The reopen sits after that fence in the same log.
- **`k01`, `slot-table.1`**: a leader takes a write on an open that has not committed. The write sits after the open in the same log. The answer to the writer waits for the commit either way (`slot-table.2`). A read served before the commit would be another matter; the model has no such read.
- **`t04`, `slot-table.6`**: the table keeps the last row written, not the highest version. Rows are written in version order here, because a new move waits for the last one's row (Finding 1). The rule earns its place with an unclean recovery: in the second model the same mistake (`u51`) is caught in 16 steps.

So these four rules hold on every bound, and the model cannot tell whether each is needed. That is a limit of the model's world, not a proof that they are spare.

**Caught only by the direct check.** `c08` leaves the token `rest` behind. Only `Whole` sees it: that is what "only carried bytes here" means.

**Two rules that only the form with no waiting needs.** `m16` and `m17` (the reopen needs the target's committed abort) are caught only on the bounds where the reopen does not wait for the row (`lazy`). With `slot-table.5` as written, the wait for the row already implies the committed abort.

**The probes** behave as the model says: `x01` (the final copy reads the source's committed log as it is now, not as it was at the fence), `x02` (the home group starts a move to the group that already holds the slot) and `x03` (an early copy is taken from a group that no longer serves the slot). None is caught.

**The second model: not caught, and why** (`u05`, `u07`, `u08`, `u12`, `u18`, `u43`, `u47`, `u50`).

- **`u05`, `u07`** (a recovered source fences, or a recovered target copies early, for a move ordered for its old life). The source's case is stopped by two other rules: its slot is shut after the recovery (R2), and once it reopens, the old move is older than its newest row (R9). An early copy alone opens nothing; the final copy has its own check (`u06`, caught). So R1 is needed on the final copy only.
- **`u08`** (a move counts as ended though its target has had a new life). Spare here: R6 writes the slot back above any move the home group started meanwhile.
- **`u12`** (R6 overrides the target's own recovery row). Cannot happen once R3 holds: a group that got a recovery row holds the final copy of the last move into it, so it cannot have given that move up as lost.
- **`u18`** (a recovered group asks for a slot its copy does not hold). R3's other two lines imply it.
- **`u43`** (a later early copy stands before an earlier one). Harmless: see "The early carried set".
- **`u47`**, `slot-move.8` (the target takes a move's final copy twice). R9 covers it: the first final copy is a row "not older" than the move.
- **`u50`**, `slot-table.4` (the source fences on a row that was written back). R9 covers it: the source's log already names that move, by its own abort.

So eight lines of the second model are spare beside the others at these bounds. They are listed with the proposals, so that the ledger takes the nine rules and not the spare ones.

**The second model: caught only by a stop.** `u17` (the reopen after a lost target does not wait for the row) makes the model stop with an error, not fail a property: the reopen then has no row to take its epoch from. `u16`, which takes the old epoch, fails `NoBack`.

**The third model: not caught, and why** (`n03`, `n04`, `n05`, `n12`, `n21`, `n23`, `n24`, `n25`, `n26`, `n27`, `n28`).

- **`n03`, `n04`, `n12`**: a guard on the committed log beside a guard on the log end. The same case as `m04`, `m15` and `k01` above, now with members. See "What it shows".
- **`n05`** (a leader fences the move a second time). In the first model this is Finding 4: it is a stall, and only the stall check sees it (`m22`). The third model has no stall check.
- **`n21`, `n24`** (a leader commits an older term's entry by counting copies; a new leader proposes a membership change before it has committed in its term). The model's hand-over gives a member the leader's whole log. So an old entry is never on a majority without the leader's own entry behind it, and these two cannot show. They need a hand-over one entry at a time, which is the Raft port's own proof (probe P1).
- **`n23`** (a membership change proposed while one is not committed): not caught, on `mem-src-cfg2` either (two membership changes, no faults). The reason is the model's form: a change is stored as the whole new set of voters, worked out from the committed configuration. Two changes that are both waiting are then each one step from that configuration, and the later one simply wins; they do not add up. A model that stores a change as a step (add one, remove one), as the port does, could show it.
- **`n25`, `n26`, `n28`** (a member outside its configuration stands; a removed leader goes on leading; a member is made a voter before its log has caught up). None can break safety here: such a member still needs a majority of a configuration and the log check to win, and a commit still needs a majority. They are rules about getting stuck or about disruption *(reasoned)*.
- **`n27`** (a configuration takes effect when appended, not when committed). With one voter added or removed at a time, both readings keep every property on these bounds.

**The third model: caught only by a stop.** `n18` and `n19` (a member votes in a term it has passed; a candidate wins without a majority) make the model stop: a member's commit index then points past its own log, which means an entry it knew committed was taken away. That is the failure itself, seen before the check `RaftSafe` could be read.

## The ledger's records, one by one

"Checked" means a marked line holds the rule and a planted mistake on it is caught, or an invariant states it. "By shape" means the model's form holds it and no line can break it alone.

| Record | Where it is in the model | Result |
|---|---|---|
| `slot-move.1` | the write guard and the fence's own guard on the log end (`m03`, `m05`) | checked |
| (no record) | the source fences a move once (`m22`) | checked; a rule the ledger lacks (Finding 4) |
| `slot-move.2` | the fence's guard on the committed log (`m04`) | holds; the mistake is not caught (see "Not caught") |
| `slot-move.3` | the fence stops the source (`m01`); it names the target and the move | checked; the name itself is a proposal |
| `slot-move.4` | the final copy reads a committed fence (`m06`) | checked |
| `slot-move.5` | the final copy's records (`m11`, `m12`, `m13`) | checked |
| `slot-move.6` | the carried lock token (`c05`) | checked |
| `slot-move.7` | the final copy's commit opens; there is no other entry (`m02`) | checked |
| `slot-move.8` | no second final copy of a move (`m08`) | checked in the first model; in the second, rule R9 covers it (`u47` is not caught) |
| `slot-move.9` | a target with no final copy answers `retry` (the last line of `Where`) | by shape, in the stall check |
| `slot-move.10` | the start of a move is one step: the order and the row | by shape |
| `slot-move.11` | the early copy reads committed records (`m18`); reads do not see it | checked; the second half by shape |
| `slot-move.12` | second model: the ready report names the place the copy reached (`u42`); the fence names it as the delta's base | the report: checked. "Only after that report": a speed rule; without it the source sends everything and every property holds |
| `slot-move.13` | second model: the early copy holds the carried set (`u41`); the delta and the merge, one line per part (`u28` to `u40`) | checked; it needs a base that the target checks (Finding 8) |
| `slot-move.14` | second model: only a final copy carries the END flag, and the target is offered early copies too (`u27`) | checked |
| `slot-move.15` | one line per part; a final copy with a part missing (`m10`); versions (`c06`); the rest (`c08`) | checked; four parts only as one token |
| `slot-move.16` | no line: the target may abort before the fence too | not a safety rule here (see "Smaller findings") |
| `slot-move.17` | no abort once the final copy is in the log (`m14`); only the target aborts (`m23`) | checked |
| `slot-move.18` | no final copy once the abort is in the log (`m07`) | checked |
| `slot-move.19` | the reopen needs the target's committed abort (`m16`, `m17`) and a fence of its own (`m15`) | checked where the reopen does not wait for the row; with `slot-table.5` as written, that rule covers it. `m15` is not caught |
| `slot-move.20` | the reopen is an entry; writes wait for its commit through `slot-table.1`'s guard | by shape |
| `slot-move.21` | no line: it never applies (Finding 3) | proposal |
| `slot-move.22` | the final copy's voter guard (`m09`); B starts a voter short; third model: counted in the newest configuration in the leader's log (`n09`, `n10`) | checked; which configuration it reads is Finding 9 |
| `slot-table.1` | the write guard on the committed log (`k01`) | holds; the mistake is not caught |
| `slot-table.2`, `slot-table.3` | not in the model: the answers | not checked |
| `slot-table.4` | the fence needs a committed row (`t01`, `t02`); `RowFirst` | checked, in the stronger form "before the fence" |
| `slot-table.5` | the reopen waits for the row (`t03`); switch `BackFirst` | checked both ways (Finding 2) |
| `slot-table.6` | the table reads the highest version (`t04`, `u51`) | checked in the second model: a recovery is what makes the order matter |
| `slot-table.7` | second model: the recovery's row has a new epoch (`u21`), and the group reopens in it (`u23`) | checked; eight more rules are needed beside it (Finding 6) |
| `move-policy.4` | one move at a time (`t08`), and when a move has ended (`t06`, `t07`) | checked (Finding 1) |
| `move-policy.1` to `.3`, `.5`, `.6` | not in the model: which slot moves and when | not safety rules |
| `stream-numbers.10` | the carried marks and answers (`c03`, `c04`) | checked |
| `stream-numbers.11` | the target reads the carried table (`m19`) | checked |
| `slot-sequence.2` | the carried sequence and epoch (`c01`, `c02`; in the delta `u34`, `u35`) | checked; the epoch moves in the second model |
| `writer-time.7` | the carried stamp (`c07`) and the target's stamp rule (`k05`) | checked |
| `caller-keys.11` | inside the token `rest` | not checked on its own |
| `subscribe.23` | segment names: inside the token `rest` | not checked on its own |
| `subscribe.29`, `subscribe.30` | `Views`: the old group still shows the records below the fence, and the new group shows them all | the property is checked; the END answer is not modelled |
| `home-records.2`, `route-forward.2`, `route-smart.1` | `Where` and `Ask`: a `moved` answer corrects a route (`m20`, `m21`, `k07`) | checked by the stall check |
| `fence-tokens.1`, `row-version.1`, `slot-sequence.1`, `stream-numbers.4` | the lines marked `@keeps` (`k02` to `k06`) | the model needs each |
| `meta-directory.2` | second model: a recovery raises the group's incarnation in the home log (`u02`) | checked: the move's rules R1 and R5 lean on it |
| `recover.1` to `.3` | second model: the recovery is one step, from any part of the committed log | the world, not checked as rules |
| `raft-term-vote`, `raft-commit`, `raft-log`, `raft-config.1`, `.3` | third model: the lines marked `@keeps` (`n17` to `n20`, `n22`, `n29`) | the move needs each |
| `raft-config.2`, `.5`, `.10`, `.12`, `.13`, `learners.3` | third model: marked `@keeps` (`n21`, `n23` to `n28`) | hold; the mistakes are not caught in this short form |
| `tier.6`, `tier.9`, `bulk-rate-cap.1`, `meta-directory.5`, `merger.6`, `merger.10`, `scan.4`, `scan.11`, `sorted-column.3`, `consumer-groups.10` | not in the model | not checked |

## Proposals for the ledger

**The owner took every proposal below, in its recommended form (card 0002; decisions V5-33 to V5-39).** See "After card 0002: the decided form".

As first written, none of these was applied: each needed the spec's own gate. The table is kept as it was proposed.

| # | Record | Old text | New text | Why | Evidence |
|---|---|---|---|---|---|
| 1 | a new record beside `move-policy.4` | (none) | "The home group starts a slot's next move only once the last move's final copy has committed or its row has been written back." | "One move at a time" does not say when a move is over; a committed abort is not enough | Finding 1; planted mistake `t06`, `TableRight` in 11 steps on `twice`; [results/finding1-trace.txt](results/finding1-trace.txt) |
| 2 | `slot-table.4` | "A move's target writes the slot's row into the home log's slot table before it serves the slot." | "A move's target writes the slot's row into the home log's slot table before the source fences the slot." | Only this order keeps the home group out of the window and the window at two entries | Finding 3; `RowFirst` on every bound; `t01`, `t02` |
| 3 | `slot-table.5` | "After a move is given up, the target writes the slot's row back to the source before the source reopens, and only if the target had written the row." | Either keep "before the source reopens" and drop the last clause; or: "After a move is given up, the target writes the slot's row back to the source; the source's reopen does not wait for it." | With the first, a slot whose move is given up waits for the home group; with the second it does not, and the table may name a target that gave up until the home group is back. The last clause is always true once the row comes before the fence | Finding 2; `s-strict` against `s-lazy`; `lazy` and `big-lazy` hold |
| 4 | `slot-move.21` | "A target that has not written the slot's table row gives the move up on a timer without the home group." | Retire it, or, if proposal 3 takes its second form: "A target that gave a move up answers moved with the move's source." | Its condition is never true after a fence. The new sentence is the rule the second form needs so that a writer still finds the slot | Finding 3 (`RowFirst`); planted mistake `m21`, caught by the stall check on `s-lazy` |
| 5 | `slot-move.3` | "The fence is one entry in the source's log that names the slot, the target and the move; it is the decision and the fence at once." | "The fence is one entry in the source's log that names the slot, the target and the move, by the number of the move's row in the slot table; it is the decision and the fence at once." | No record says what a move's name is, and the fused probe's name (the fence's own place) does not exist yet when the row is written | every bound holds with this name |
| 6 | `slot-move.17` and `slot-move.16` | .17: "After the fence, only the target gives a move up, by an abort entry, and only while its log holds no final copy for that move." .16: "Before the fence, only the source drops a move; the target then drops its unseen copy." | .17: "The target gives a move up by an abort entry, before the fence or after it, and only while its log holds no final copy for that move." .16: retire, or keep only as the hygiene rule "A target that gave a move up drops its unseen copy." | The model's target aborts before the fence too and nothing breaks; a source that drops a move just never fences | every bound holds; `m14` |
| 7 | a new record in `slot-move` | (none) | "The source fences a move only once, and never a move older than the newest one its slot has taken part in." | A late report of a finished move must not fence the slot again; `slot-move.8` is the same rule on the target's side | Finding 4; planted mistake `m22`, the stall check on `s-twice` |
| 8 | `slot-move.7` and `slot-table.1`, if the window is to hold one commit | .7: "The target logs the final copy as one entry, and that entry's commit opens the slot at the target; there is no separate open entry." .1: "A group takes a write only for a slot its committed log holds open; otherwise it answers moved." | .7: "The target logs the final copy as one entry and takes writes to the slot behind it at once; reads of the slot and answers wait for that entry's commit; there is no separate open entry." .1: "A group takes a write only for a slot its log holds open, and answers it only once it has committed; otherwise it answers moved." | As written the window holds two commits, and the record's own timing puts two commits over the 10 ms bar | Finding 5; planted mistake `k01` is not caught on any bound; `OneTaker` |
| 9 | the `known` and `evidence` fields of `slot-move.1`, `.3` to `.8`, `.11`, `.15`, `.17` to `.20`, `.22`, `slot-table.4` to `.5`, `stream-numbers.10`, `.11`, `slot-sequence.2`, `writer-time.7` | "partial model: ..." or "reasoned" | `model`, naming this folder | this model has the one-commit form with the table in the home log, the home group down and the carried set | the bounds table and `results/mutants.md` |
| 10 | `slot-table.7`, and new records beside it (Finding 6) | "A recovery writes the slot's row at the slot's new epoch." | Keep the sense, and add: (R1) "A move's row holds the incarnation of its target, and the target takes the move's final copy only in that incarnation." (R2, R4) "After an operator recovery a group serves none of its slots until the home log holds its row for the slot at a new epoch; it reopens in that epoch." (R3) "The home group's leader gives a recovered group that row only if the table names the group and the group's copy holds the final copy of the last move into it." (R5 to R7) "A target that gives a move up in another incarnation than the row names marks the abort lost. If the table still has the slot at that target by that move, the home group writes the row back as a new row above every other, at a new epoch, and the source reopens only after that row, in its epoch." | One rule does not hold a recovery; with any of these gone a property fails | second model: `u01` to `u26`; the failures listed under its bounds |
| 11 | proposal 7, restated (Finding 7) | proposal 7's text | "A group never fences, and never takes a final copy, for a move older than the newest row its log names; and a group that holds a slot open takes no final copy for it." `slot-move.8` then follows from it. | With a recovery, a late report of an old move must not act on either side | `u24`, `u25`, `u26`; `u47` not caught |
| 12 | `slot-move.13` (Finding 8) | "The source sends the carried set before the fence, so only a small delta crosses the unwritable window." | Add: "The fence names the place the delta starts from, and the target takes the final copy only if its early copy stands at that place." | A delta merged onto another base applies a record twice | `u28`, `u29`; `msg-r-early` |
| 13 | `slot-move.12` | "The target reports the position its copy reached, and the source fences only after that report." | Split: "The target reports the position its copy reached." stays a rule; "the source fences only after that report" moves to the speed rules, or is dropped | Only the first half is needed for a property; without the second the source sends everything | `u42`; the bounds without `NeedReady` |
| 14 | `slot-move.22` (Finding 9) | "No slot opens in a group that has fewer voters than the resource's copies setting." | "No slot opens in a group that has fewer voters than the resource's copies setting, counted in the newest configuration in the leader's log, committed or not." | Counted in the committed configuration, a pending "one voter less" lets a slot open in a group of two | third model: `n09`, `OpenFull` in 10 steps on `mem-dst-shrink` |
| 15 | `slot-table.6` | "The slot table keeps the highest version of each slot's row." | Add what a version is: "A row's version is its number in the home log, then its step; a recovery's row and a row written back after a lost target take a new number." | No record says what a row's version is, and the order is what a recovery leans on | `u51`, `u14` |
| 16 | the `known` and `evidence` fields of `slot-move.12` to `.14`, `slot-table.6`, `slot-table.7`, and K-01's line in the records that owe it | "reasoned", "model owed" | `model`, naming this folder and its bounds | the second and third models have them | the bounds tables |

Proposals 1 to 4, 7, 8 and 10 to 15 change what a rule says and may change a count, so they go through the spec's gate. Proposals 3 and 8 are choices for the owner: 3 trades an exact table against waiting for the home group, and 8 touches a speed bar. Proposal 10 is one too: it adds about eight rules to slice 3's budget. A smaller way is to let a recovered target give nothing up, so that a slot caught in a move by a recovery waits for the operator; that keeps R1 to R4, R9 and R10 and leaves out R5 to R7 *(reasoned; not modelled)*. Not proposed, because the models show them spare: a source-side incarnation check, "a move whose target has had a new life has not ended", and "its copy holds the slot" beside R3. `slot-move.2`, `slot-table.1` and the "fence of its own" half of `slot-move.19` hold in all three models but no planted mistake on them is caught, with members either (`n03`, `n04`, `n12`); that is a reason to look at whether each still counts as a rule of its own, not a proposal to drop any.

## What is left out

- **An unclean recovery of the home group**, and a recovery in the worlds of the first and third models. The second model recovers data groups only, with a small carried set. After a recovery it checks safety, not that the slot is served again: some states there need the operator.
- **A third data group.** Every model has two. Rule R6 (the row written back after a lost target) was shaped on two groups; with three, a slot that moved on from the lost target to a third group is a case no bound here has *(reasoned)*.
- **Members in both groups at once, and in the home group.** The third model gives members to one data group at a time, with one move and no slot table. Its Raft steps are short forms: one-step elections, a hand-over of the whole log, one voter added or removed at a time, a change stored as the whole new set of voters. Three planted mistakes on Raft's rules cannot show in that form (`n21`, `n23`, `n24`); a hand-over one entry at a time and changes stored as steps would let them. Joint steps, learners, pre-vote and snapshots are the Raft port's own (probe P1).
- **Four members with two faults.** That bound did not finish (see the third model's bounds). The complete bounds have three members.
- **The order to move as a message** (`slot-move.10`). The start of a move is one step in the home log.
- **The window's time.** That is GROUPS 4.3 row 7, on real code.
- **The merger** (E-67), a second slot, the floors, a session lapse, the object store's restore mark, snapshots and log drops (E-32 had them with the three-commit move).
- **Liveness beyond the stall check.** The stall check asks "can it still finish", on small bounds of the first model. It does not ask "does it finish under fair scheduling". The second and third models have reach checks only.
- **Lock tokens, row versions and stamps with a recovery or an early carried set.** Each part's own end property is checked in the first model, where the carried set crosses whole. The second model checks the delta and the merge on the sequence, the epoch, the high marks, the kept answers and the token.

## A second reading

A second pass over the three models, made after the first write-up: every counted bound run again, the models read against the ledger line by line, bounds added where two faults had never been side by side, and mistakes planted on lines the first list does not have. It changed no rule line of any model. What it added: two reach goals (`NotTwice` in the second model, `NotBack` in the third), 16 bounds (one of them not counted), [extra-mutants.txt](extra-mutants.txt) with its runner [extra.py](extra.py), and this section.

### The reruns

Every safety bound and stall check of the three models ended with the same result and the same count of distinct states as in the tables above: 43 safety bounds and 3 stall checks *(measured)*. The 13 reach goals were reached again. A reach run stops at the first state that meets its goal, and with two workers that state is not the same one each time, so a reach bound's state count changes a little from run to run (`r-moved`: 218, 241 and 246 in three runs); only "goal reached" is the result *(measured)*.

One number of Finding 2 was looked at again. The stall check counts a membership change as a fault, so a target that is one voter short cannot grow on a calm path. With the membership change counted as a calm step, `s-strict` has 948 stuck states of 6,688, not 998 *(measured)*. The finding stands: a give-up while the home group is down leaves the slot with no writes.

### Bounds added

Each puts two things side by side that no bound above had together. All pass *(checked; states and times measured, one worker, beside other runs)*.

| Bound | Model | What it adds | Result | Distinct states | Depth | Time |
|---|---|---|---|---|---|---|
| `x-ver-copy` | first | "only if at version v" with an early copy, two moves, a leader change | pass | 15,332 | 29 | 7 s |
| `x-lock-ver` | first | lock tokens and "only if at version v" together, two streams of two writes, a membership change, B a voter short | pass | 274,352 | 25 | 78 s |
| `x-lazy-ver` | first | the reopen that does not wait for the row, with "only if at version v", an early copy, a group down, a membership change, B a voter short | pass | 1,498,675 | 33 | 389 s |
| `msg-x-lazy-down` | second | the reopen that does not wait for the row, with a recovery, a leader change and the home group down | pass | 126,180 | 34 | 70 s |
| `msg-x-s2n2` | second | two streams of two writes with a recovery and an early copy | pass | 438,735 | 31 | 211 s |
| `msg-x-rec2-down` | second | two recoveries with the home group down and a leader change, two moves | pass | 904,392 | 36 | 453 s |
| `msg-x-rec2-early` | second | two recoveries with an early copy, two moves | pass | 3,151,608 | 36 | 1643 s |
| `mem-x-src-pcrash` | third | the source with members, a member fault, two terms, and a leader change in the target | pass | 269,330 | 24 | 43 s |
| `mem-x-dst-pcrash` | third | the target with members, a member fault, two terms, and a leader change in the source | pass | 150,562 | 22 | 22 s |
| `mem-x-dst-grow-fault` | third | a target that starts a voter short and grows, with a member fault and a second election | pass | 380,003 | 25 | 45 s |
| `mem-x-src-n2` | third | two writes, with a member fault and two terms | pass | 467,116 | 25 | 83 s |
| `mem-x-src-cfg2-fault` | third | two membership changes (a voter less, then a voter more) with a member fault and two terms | pass | 7,611,724 | 29 | 1186 s |
| `mem-x-src-add-term` | third | four members, three of them voters: a voter is added, with a second election | pass | 6,712,545 | 31 | 1304 s |
| `msg-r-twice` | second | reach: the slot moves to B and back, and A takes a write | goal reached | | | 3 s |
| `mem-r-back` | third | reach: the move is given up, the source reopens and takes a write | goal reached | | | 2 s |

**One added bound is not counted.** `mem-x-src-add-fault.cfg` (four members, three of them voters; a voter added, one member fault, two terms) was stopped by hand after 23 minutes, at 10,853,567 distinct states with 5,059,773 still waiting, at depth 14 *(measured)*. No property had failed. That is not a pass. `run.sh` does not run it unless it is named. So a voter added while a member is down is still open, as `mem-deep-four` is; `mem-x-src-add-term` has the added voter with a second election and no fault, and `mem-x-src-cfg2-fault` has the fault with a voter removed and added back among three members.

Why these. In the third model no bound above let the other group's leader change (`MaxPCrash` was 0 in every `mem-*` bound), none had more than one write, and the growing target met no fault. In the second model the form where the reopen does not wait for the row never met the home group down, and two recoveries never met an early copy or the home group down. In the first model the version check never met an early copy or a lock token. The second and third models had no reach goal for a second move or for a give-up.

### More planted mistakes

[extra-mutants.txt](extra-mutants.txt) holds 30 one-line changes on lines that `mutants.txt` does not list; most of those lines carry no mark. [extra.py](extra.py) runs each on its model's small bounds and reach checks (not the stall check). The table is [results/extra-mutants.md](results/extra-mutants.md).

| Model | Planted | Caught | Probes (expected harmless) | Probes caught |
|---|---|---|---|---|
| first | 10 | 10 | 1 | 0 |
| second | 9 | 8 | 5 | 2 |
| third | 5 | 4 | 0 | |
| **all** | **24** | **22 (92 %)** | **6** | **2** |

All *(measured)*. What they show:

- **Lines without a mark that hold a rule.** In the second model: the target checks that the fence names it (`f12`: with a recovery a source takes its own old fence report for a final copy, and two groups hold the slot open in 8 steps; in the first model, with no recovery, the same change is not caught, `e14`); the fence takes the target's incarnation from the row, not from now (`f11`, `TableRight` in 10 steps); a group reopens only on its own recovery row (`f04`); the recovery's own entry is committed before anything else (`f06`); the final copy's entry takes the source's epoch (`f01`); the row written back names the source and takes its epoch from its own move's row (`f03`, `f09`). The reader had put `f11` and `f12` down as harmless; they are not. So the second model's list of rules is longer than its marks: these lines belong to R1, R2 and `slot-move.3`.
- **Finding 9 shows in the first model too.** Voters counted in the committed log, not at the log end: `OpenFull` fails in 9 steps on `ver` (`e02`).
- **`u35` and `u37` are caught only by the direct check.** In the second model the epoch a group serves in is read from the final copy's own entry, not from the carried table's `ep` part. So the two planted mistakes on that part change nothing but the comparison `Whole`. The line that matters is the unmarked one of `f01`, and it is caught by `InOrder`.
- **A recovery's row does not need a new number here** (`f05`, not caught). Its step, which is above a move's two steps, already puts it on top. So proposal 15's "a recovery's row takes a new number" is shown for the row written back after a lost target (`u14`), not for the recovery's own row.
- **Finding 5's change holds with a recovery too** (`f15`, not caught): a leader that takes writes behind a final copy or a reopen that has not committed breaks no property on the second model's bounds.
- **`g05` is not caught, and that is the fence at work**: after a fence a source's log takes no write until a reopen, and a reopen needs a committed abort, after which no final copy commits. So "the records before the fence" and "the records of the whole log" are the same wherever a final copy can commit.
- **`f08`** (a final copy makes no report) is caught only by the new reach goal `msg-r-twice`: without it no bound of the second model asked for a second move to complete.
- **`g03` and `g04`** are caught by a stop, like `n18` and `n19`: a member's commit index points past its log, and the check `RaftSafe` cannot be read.

Three changes were dropped before they were counted, because they made the state space endless (a step that could then repeat for ever): a second reopen for one fence, a row written back any number of times, an abort logged again while the first is not committed. `f14` allows the row to be written back twice at most; one of its runs passed the 15-minute limit set for these runs, so it is a probe with one bound open.

### What the reading says of the write-up above

- **The planted-mistake numbers are right**: 108 of 131 (82 %), by model 42 of 46, 48 of 56 and 18 of 29 *(counted again from `results/mutants.json`)*. Twelve of them, picked across the three models, were planted and run again; each ended as listed *(measured)*.
- **The bar.** The first and second models pass 85 %; the third does not, and the three together do not. With the 24 extra mistakes the three together stand at 130 of 155 (84 %). The mistakes that are not caught are equivalent changes (a guard on the committed log beside a guard on the log end; a rule another rule already implies) or need a deeper Raft model; none found here is a hole in a property.
- **Which ledger records have a caught mistake.** Of `slot-move.1` to `.22`: sixteen do (`.1`, `.3` to `.8`, `.11` to `.15`, `.17` to `.19`, `.22`; `.12` for its first half). `.2` holds with its mistake not caught. `.9`, `.10` and `.20` are held by the model's shape, with no line that could be wrong alone. `.16` and `.21` have no line: the model takes another reading and proposes to change them. So "the model checks `slot-move.1` to `.22`" is true of sixteen.
- **The reading of `slot-table.4` is the model's choice.** The ledger's words allow the row inside the window, and the record's own answer to the home group going down (a target that never wrote the row gives up alone, `slot-move.21`) belongs to that reading. The models run only the other one, the row before the fence. The reading inside the window is reasoned about in Finding 3 and never run.
- **Mistakes are hand-listed, on marked lines.** The record's counting rule asks for mistakes made mechanically from the model text. The extra list above is a cross-check from the other side: lines nobody had marked.

## After card 0002: the decided form

The owner answered card 0002 with the recommended option on all nine questions (decisions V5-33 to V5-39). For the move that settles three choices the models had left open, and it makes the rules the second model needed into ledger records. This section runs the move in that form: a switch, new bounds, planted mistakes and marks. At the switch's default every model runs as it did.

### What was decided

- **The row comes before the fence** (`slot-table.4`). The models already do this.
- **After a give-up the source reopens first** (`slot-table.5`). It waits for the target's committed abort, not for the row; the row goes back when the home group answers. A give-up marked lost is the one exception: then the source waits for its row, which holds the new epoch (`slot-table.11`). This is `BackFirst = FALSE`, the form the earlier bounds called "the reopen does not wait for the row".
- **One commit in the window** (`slot-table.1`, `slot-move.7`). A group takes a write for a slot its log holds open, committed or not. So the target takes writes behind its final copy at once, and the source behind its reopen. This was planted mistake `k01` in the first model, `f15` in the second and `n03` in the third; it is now `OneCommit = TRUE`.
- **Every rule the second model holds stays**, and now has a record:

| Rule here | Ledger record |
|---|---|
| R1, the target's half (`row.inc`), and the fence that names the target (`f11`, `f12`) | `slot-table.8` |
| R2, R4 (`recover.shut`, `recover.row`, `recover.epoch`) | `slot-table.9`, beside `slot-table.7` |
| R3 (`recover.table`, `recover.final`, `recover.copy`) | `slot-table.10` |
| R5 to R7 (`abort.lost`, `back.lost`, `back.epoch`, `unf.wait`, `unf.epoch`) | `slot-table.11` |
| R9, R10 and Finding 4 (`fence.newer`, `final.newer`, `final.shut`, `fence.once`) | `slot-move.24` |
| Finding 1, when a move has ended (`ended.back`, `ended.open`) | `move-policy.7` |
| what a target that gave up answers (`moved.abort`) | `slot-move.23`, in place of the retired slot-move.21 |
| Finding 8, the base of the delta (`delta.base`) | `slot-move.13` |

### The switch

`OneCommit` is a definition with a default, `FALSE`, in each of the three models. A `.cfg` may set it (`OneCommit = TRUE`), and TLC then uses that value in place of the definition. So an older `.cfg` runs as it did, and no older `.cfg` was changed. The guard now reads:

```
    /\ Mode(g, CL(g)) = "open" \/ OneCommit                     \* @rule two-commit
    /\ Mode(g, log[g]) = "open"                                 \* @rule slot-table.1 slot-move.1
```

A bound of the decided form sets `OneCommit = TRUE` and `BackFirst = FALSE`; the third model has no slot table, so only the first. Each is an older bound's world with only those two switches changed, and it takes that bound's name after `d-` (first model), `msg-d-` or `mem-d-`. Four older bounds have no twin, because the twin would repeat a world: `big-lazy` (it is `d-big-all`), `msg-rec-lazy` (`msg-d-rec-twice`), `s-strict` (`d-s-lazy`), and `mem-src-cfg2`, which has no writes, so the switch changes nothing in it. The three bounds that did not finish have no twin either.

**The older bounds keep their counts.** After the switch and the new marks went in, `./run.sh` ended `ok slot-move`: all 28 safety bounds and the 3 stall checks have the same distinct states and the same depth as in the tables above, and the 12 reach goals are reached again *(measured)*. So the switch's default and the marks change no state.

**A cross-check.** `d-lazy` has 27,180 distinct states, the count `k01` had on `lazy` in its own run ([results/k01-runs.txt](results/k01-runs.txt)): `lazy` already had `BackFirst = FALSE`, so `d-lazy` is `lazy` with `k01` *(measured)*.

The stall check's answers (`Where`, `Ask`) are as they were: a group answers `moved` while its committed log does not hold the slot open. So in the decided form a group whose log end holds the slot open, not yet committed, may answer `moved` where the real group would take the write. That adds a step and takes none away, and from such a state the real group's own path, take the write and commit, is always there too; so the extra step is never the only way out *(reasoned)*.

### Bounds and results

Same box and tools, with another model job beside these runs the whole time: TLC2 2026.11.19 on Java 21, 2 workers, `-fp 31`, a 2 GB heap for the small bounds and a 2 or 3 GB heap for the big ones. Every run is complete *(checked; states and times measured)*. "The world of" names the older bound whose world it is; its row in the tables above says what that world has. The last column is the older bound's distinct states, where it was counted. Times are wall-clock on a busy box, so read them as rough. A run marked "resumed" passed the hour's limit (3,500 s here), and went on from its last checkpoint; its time is the two parts together.

**The first model, small bounds and reach checks.**

| Bound | The world of | Result | Distinct states | Depth | Time | The older bound's states |
|---|---|---|---|---|---|---|
| `d-core` | `core` | pass | 151 | 15 | 2 s | 113 |
| `d-crash` | `crash` | pass | 5,742 | 21 | 4 s | 4,322 |
| `d-bulk` | `bulk` | pass | 13,874 | 23 | 6 s | 10,475 |
| `d-twice` | `twice` | pass | 22,644 | 29 | 9 s | 16,092 |
| `d-lock` | `lock` | pass | 3,215 | 19 | 2 s | 2,436 |
| `d-ver` | `ver` | pass | 63,993 | 22 | 15 s | 46,291 |
| `d-ver2` | `ver2` | pass | 1,427 | 19 | 3 s | 987 |
| `d-lazy` | `lazy` | pass | 27,180 | 29 | 7 s | 23,780 |
| `d-down` | `down` | pass | 232,025 | 23 | 35 s | 176,840 |
| `d-r-moved` | `r-moved` | goal reached | 241 | 11 | 2 s | reached |
| `d-r-back` | `r-back` | goal reached | 132 | 13 | 1 s | reached |
| `d-r-twice` | `r-twice` | goal reached | 620 | 18 | 2 s | reached |
| `d-r-hard` | `r-hard` | goal reached | 1,225,683 | 19 | 63 s | reached |

**The first model, big bounds.**

| Bound | The world of | Result | Distinct states | Depth | Time | The older bound's states |
|---|---|---|---|---|---|---|
| `d-big-two` | `big-two` | pass | 91,138 | 33 | 22 s | 66,703 |
| `d-big-lock` | `big-lock` | pass | 327,645 | 32 | 65 s | 233,670 |
| `d-big-three` | `big-three` | pass | 448,826 | 34 | 177 s | 323,359 |
| `d-big-faults` | `big-faults` | pass | 903,585 | 25 | 200 s | 710,725 |
| `d-big-streams` | `big-streams` | pass | 1,122,650 | 34 | 593 s | 758,790 |
| `d-big-all` | `big-all` | pass | 2,303,315 | 33 | 590 s | 1,658,720 |
| `d-big-ver` | `big-ver` | pass | 11,658,335 | 37 | 3123 s | 8,001,160 |
| `d-x-ver-copy` | `x-ver-copy` | pass | 21,534 | 29 | 11 s | 15,332 |
| `d-x-lock-ver` | `x-lock-ver` | pass | 373,314 | 25 | 149 s | 274,352 |
| `d-x-lazy-ver` | `x-lazy-ver` | pass | 1,612,700 | 33 | 424 s | 1,498,675 |

**The second model, small bounds and reach checks.**

| Bound | The world of | Result | Distinct states | Depth | Time | The older bound's states |
|---|---|---|---|---|---|---|
| `msg-d-core` | `msg-core` | pass | 114 | 13 | 1 s | 92 |
| `msg-d-early` | `msg-early` | pass | 414 | 17 | 2 s | 356 |
| `msg-d-crash` | `msg-crash` | pass | 988 | 17 | 3 s | 804 |
| `msg-d-rec` | `msg-rec` | pass | 1,752 | 21 | 4 s | 1,406 |
| `msg-d-rec-early` | `msg-rec-early` | pass | 9,382 | 23 | 8 s | 7,624 |
| `msg-d-rec-crash` | `msg-rec-crash` | pass | 3,504 | 23 | 5 s | 2,812 |
| `msg-d-rec-down` | `msg-rec-down` | pass | 5,256 | 23 | 7 s | 4,218 |
| `msg-d-rec-twice` | `msg-rec-twice` | pass | 23,493 | 30 | 16 s | 18,967 |
| `msg-d-rec-three` | `msg-rec-three` | pass | 98,118 | 36 | 67 s | 83,688 |
| `msg-d-rec2` | `msg-rec2` | pass | 176,659 | 32 | 75 s | 150,732 |
| `msg-d-r-early` | `msg-r-early` | goal reached | 394 | 14 | 3 s | reached |
| `msg-d-r-lostback` | `msg-r-lostback` | goal reached | 1,129 | 13 | 3 s | reached |
| `msg-d-r-reopen` | `msg-r-reopen` | goal reached | 405 | 9 | 2 s | reached |
| `msg-d-r-oldreport` | `msg-r-oldreport` | goal reached | 567 | 10 | 3 s | reached |
| `msg-d-r-aftersrc` | `msg-r-aftersrc` | goal reached | 1,128 | 13 | 3 s | reached |
| `msg-d-r-afterdst` | `msg-r-afterdst` | goal reached | 620 | 10 | 3 s | reached |
| `msg-d-r-twice` | `msg-r-twice` | goal reached | 387 | 14 | 3 s | reached |

**The second model, big bounds.**

| Bound | The world of | Result | Distinct states | Depth | Time | The older bound's states |
|---|---|---|---|---|---|---|
| `msg-d-big-three` | `msg-big-three` | pass | 296,053 | 40 | 271 s | 240,077 |
| `msg-d-big-all` | `msg-big-all` | pass | 129,444 | 27 | 44 s | 103,602 |
| `msg-d-big-rec` | `msg-big-rec` | pass | 1,258,098 | 40 | 763 s | 1,018,412 |
| `msg-d-big-early` | `msg-big-early` | pass | 1,324,172 | 39 | 809 s | 1,162,414 |
| `msg-d-deep-all` | `msg-deep-all` | pass | 7,876,110 | 38 | 6307 s (resumed) | 6,480,516 |
| `msg-d-x-lazy-down` | `msg-x-lazy-down` | pass | 140,958 | 34 | 80 s | 126,180 |
| `msg-d-x-s2n2` | `msg-x-s2n2` | pass | 573,870 | 31 | 331 s | 438,735 |
| `msg-d-x-rec2-down` | `msg-x-rec2-down` | pass | 1,059,954 | 36 | 537 s | 904,392 |
| `msg-d-x-rec2-early` | `msg-x-rec2-early` | pass | 3,622,013 | 36 | 2390 s | 3,151,608 |

**The third model, small bounds and reach checks.**

| Bound | The world of | Result | Distinct states | Depth | Time | The older bound's states |
|---|---|---|---|---|---|---|
| `mem-d-src-core` | `mem-src-core` | pass | 1,020 | 16 | 3 s | 948 |
| `mem-d-dst-core` | `mem-dst-core` | pass | 771 | 15 | 2 s | 678 |
| `mem-d-dst-grow` | `mem-dst-grow` | pass | 7,106 | 19 | 6 s | 6,710 |
| `mem-d-dst-shrink` | `mem-dst-shrink` | pass | 7,190 | 18 | 6 s | 6,391 |
| `mem-d-src-fault` | `mem-src-fault` | pass | 146,876 | 21 | 26 s | 134,665 |
| `mem-d-dst-fault` | `mem-dst-fault` | pass | 90,838 | 21 | 19 s | 75,281 |
| `mem-d-src-cfg` | `mem-src-cfg` | pass | 173,229 | 23 | 27 s | 153,112 |
| `mem-d-src-r` | `mem-src-r` | goal reached | 643 | 9 | 1 s | reached |
| `mem-d-dst-r` | `mem-dst-r` | goal reached | 4,340 | 12 | 2 s | reached |
| `mem-d-r-back` | `mem-r-back` | goal reached | 877 | 12 | 2 s | reached |

**The third model, big bounds.**

| Bound | The world of | Result | Distinct states | Depth | Time | The older bound's states |
|---|---|---|---|---|---|---|
| `mem-d-dst-two` | `mem-dst-two` | pass | 2,495,799 | 26 | 395 s | 2,133,498 |
| `mem-d-src-two` | `mem-src-two` | pass | 5,590,083 | 26 | 830 s | 4,969,277 |
| `mem-d-r-two` | `mem-r-two` | goal reached | 2,241,381 | 15 | 148 s | reached |
| `mem-d-x-src-pcrash` | `mem-x-src-pcrash` | pass | 293,752 | 23 | 53 s | 269,330 |
| `mem-d-x-dst-pcrash` | `mem-x-dst-pcrash` | pass | 181,676 | 23 | 32 s | 150,562 |
| `mem-d-x-dst-grow-fault` | `mem-x-dst-grow-fault` | pass | 412,730 | 26 | 64 s | 380,003 |
| `mem-d-x-src-n2` | `mem-x-src-n2` | pass | 529,117 | 23 | 111 s | 467,116 |
| `mem-d-x-src-cfg2-fault` | `mem-x-src-cfg2-fault` | pass | 8,632,530 | 28 | 1203 s | 7,611,724 |
| `mem-d-x-src-add-term` | `mem-x-src-add-term` | pass | 7,675,708 | 29 | 1569 s | 6,712,545 |

**The stall checks** of the decided form. One stream, and a writer follows its route, as before.

| Bound | The world of | States | Home up: the writes can finish | Home up: and the table names the server | Home down: the writes can finish without it |
|---|---|---|---|---|---|
| `d-s-lazy` | `s-lazy` (and `s-strict`) | 44,120 | 0 stuck of 17,648 | 0 stuck of 17,648 | 0 stuck of 8,824 |
| `d-s-twice` | `s-twice` | 4,460 | 0 stuck of 1,784 | 0 stuck of 1,784 | 0 stuck of 892 |

So in the decided form no state is stuck, with the home group down too *(checked)*. That is the result Finding 2 asked for, now with one commit in the window.

In all 53 safety bounds of the decided form, 62,072,070 distinct states, every property holding on each: by model 19 bounds and 19,233,293 states, 19 and 16,600,352, and 15 and 26,238,425. The largest is `d-big-ver`, 11,658,335 states. The longest run is `msg-d-deep-all`: stopped at the limit after 3,500 s, then 2,807 s more from its checkpoint; every run uses the same fingerprint function, so its count is the whole space's, as the resume test in "How to run it" showed *(measured)*. All 15 reach goals are reached. Every safety bound of the decided form has more states than its older twin, from 6 % (`mem-d-dst-grow`) to 48 % (`d-big-streams`): the target takes writes sooner, and the source reopens sooner *(measured; the reason is reasoned)*.

### Planted mistakes in the decided form

[decided-mutants.txt](decided-mutants.txt) lists 61 one-line mistakes on the lines that hold the new and the changed records. 53 are the mistakes of `mutants.txt` and `extra-mutants.txt` on those lines, planted again as they stand there; 8 are new (ids `d`), for lines that had none or for the record's own words. [decided.py](decided.py) plants each in the decided form and runs it as `mutate.py` does: the small bounds (in the first model first without `Whole`), the reach checks, the stall checks (first model), then the slower bounds, all of them `d-`, `msg-d-` or `mem-d-` bounds. The full table, with runs and times, is [results/decided-mutants.md](results/decided-mutants.md).

| Record | Planted | Caught | Not caught, and why |
|---|---|---|---|
| `slot-table.8` | 4 | 4 | |
| `slot-table.9` | 4 | 4 | |
| `slot-table.10` | 3 | 2 | `u18`: the other two lines imply it, as before |
| `slot-table.11` | 9 | 8 | `u12`: R3 makes its case impossible, as before |
| `slot-move.24` | 5 | 4 | `n05`: a stall only a stall check sees, and the third model has none, as before |
| `slot-move.23` | 1 | 1 | |
| `move-policy.7` | 4 | 4 | |
| `slot-table.5`, the reopen first (and `slot-move.19`'s two guards on it) | 8 | 7 | `d03`: the reopen that waits for the row only makes a slot wait; the second model has no stall check |
| the write guard at the log end (`slot-table.1`, `slot-move.1`, `.3`, `.4`, `.7`, `stream-numbers.4`) | 13 | 13 | |
| `slot-move.13`, the base check | 2 | 2 | |
| **the records' own lines** | **53** | **49 (92 %)** | |
| probes of the record's words (`slot-move.24`: `d05` to `d08`) | 4 | 2 | `d05`, `d07`: harmless, as expected; `d06` is Finding 10; `d08` leaves out the record's second half (see Finding 10) |
| lines the ledger took no record for (`u03`, `u05`, `u07`, `u08`) | 4 | 1 | spare, as before; `u03` is caught only because `u05`'s line is there |

All *(measured)*. **Every reused mistake ends as it did on the older bounds**: the same 47 caught and the same 6 not caught. Some are caught sooner or by another property: `m03` by `PosUnique` in 4 steps (was `Views` in 9), `u45` by `NoLoss` in 3 (was 8), `n02` by `Views` in 4 (was 8), `u06` and `f11` by `OneTaker` in 9 (were `TableRight` in 10). `m16` and `m17`, which only the bounds with the reopen first could catch, are now caught on `d-crash` and `d-core`.

| Record | Id | Model | The mistake | Caught by |
|---|---|---|---|---|
| `slot-table.8` | u04 | second | a move's row does not hold the target's incarnation | reach goal lost: msg-d-r-afterdst |
| `slot-table.8` | u06 | second | a recovered target takes a final copy ordered for its old life | OneTaker on msg-d-rec, 9 steps |
| `slot-table.8` | f11 | second | the fence binds the target's incarnation of now, not the row's | OneTaker on msg-d-rec, 9 steps |
| `slot-table.8` | f12 | second | the target does not check that the fence names it | OneTaker on msg-d-rec2, 8 steps |
| (no record) | u03 | second | a move's row does not hold the source's incarnation | reach goal lost: msg-d-r-aftersrc |
| (no record) | u05 | second | a recovered source fences a move ordered for its old life | **not caught** |
| (no record) | u07 | second | a recovered target copies early for a move ordered for its old life | **not caught** |
| `slot-table.9` | u01 | second | a recovered group goes on serving the slot from its cut log | OneServer on msg-d-rec, 2 steps |
| `slot-table.9` | u22 | second | a group reopens on the recovery row of an older life | NoBack on msg-d-rec2, 10 steps |
| `slot-table.9` | u23 | second | a recovered group reopens in its old epoch | NoBack on msg-d-rec, 7 steps |
| `slot-table.9` | f04 | second | a group reopens on another group's recovery row | StateRight on msg-d-rec2, 6 steps |
| `slot-table.10` | u18 | second | a recovered group asks for a slot its copy does not hold | **not caught** |
| `slot-table.10` | u19 | second | a recovered group gets a row for a slot the table gives to another group | TableRight on msg-d-rec, 8 steps |
| `slot-table.10` | u20 | second | a recovered group gets a row though its copy is older than the last move into it | TableRight on msg-d-rec-twice, 9 steps |
| `slot-table.11` | u09 | second | a recovered target does not say its old life's records may be lost | NoBack on msg-d-rec, 13 steps |
| `slot-table.11` | u10 | second | the row written back after a lost target is an ordinary one | NoBack on msg-d-rec, 14 steps |
| `slot-table.11` | u11 | second | a lost target's old move overrides a newer move into it | TableRight on msg-d-rec-three, 20 steps |
| `slot-table.11` | u12 | second | a lost target's old move overrides its own recovery row | **not caught** |
| `slot-table.11` | u13 | second | a move out of the lost target hides that the slot went back | NoBack on msg-d-rec-twice, 15 steps |
| `slot-table.11` | u14 | second | the row written back after a lost target is not above the later rows | TableRight on msg-d-rec-twice, 16 steps |
| `slot-table.11` | u15 | second | the row written back after a lost target keeps the old epoch | NoBack on msg-d-rec, 14 steps |
| `slot-table.11` | u16 | second | the source reopens in its old epoch after a lost target | NoBack on msg-d-rec, 14 steps |
| `slot-table.11` | u17 | second | the source reopens after a lost target before the row is written back | the model stops on msg-d-rec |
| `slot-move.24` | m22 | first | the source fences one move a second time | stall check, d-s-twice (home up: the writes can finish; home up: and the table names the server; home down: the writes can finish without it) |
| `slot-move.24` | u24 | second | the source fences a move older than one it already acted on | InOrder on msg-d-rec-twice, 24 steps |
| `slot-move.24` | u25 | second | a group that holds the slot open takes a final copy | NoBack on msg-d-rec-twice, 19 steps |
| `slot-move.24` | u26 | second | a group takes the final copy of a move older than one it already acted on | OneTaker on msg-d-rec-three, 20 steps |
| `slot-move.24` | n05 | third | a leader fences the move a second time | **not caught** |
| `slot-move.24` | d05 | first | (probe) the record as written bars only a move older than the newest its log names, so the source may fence the newest move again (twice at most here) | **not caught** |
| `slot-move.24` | d06 | second | (probe) the record as written, for the fence: the newest move its log names may be fenced again (twice at most here) | NoBack on msg-d-rec-twice, 21 steps |
| `slot-move.24` | d07 | second | (probe) the record as written, for the final copy: a final copy for the newest move its log names is not barred by this line | **not caught** |
| `slot-move.24` | d08 | first | slot-move.8 replaced by the first half of slot-move.24 alone: the target takes a final copy unless its log names a newer move | Views on d-core, 11 steps |
| `slot-move.23` | m21 | first | a target that gave up answers retry, not moved | stall check, d-s-lazy (home down: the writes can finish without it) |
| `move-policy.7` | t06 | first | a move counts as ended once its abort commits, row or no row | TableRight on d-twice, 11 steps |
| `move-policy.7` | t07 | first | a move counts as ended on a final copy that has not committed | TableRight on d-twice, 17 steps |
| `move-policy.7` | u53 | second | a move counts as ended with no final copy | TableRight on msg-d-rec-twice, 6 steps |
| `move-policy.7` | d04 | second | a move counts as ended once its abort is reported, row or no row (t06 in the second model) | TableRight on msg-d-rec-twice, 8 steps |
| (no record) | u08 | second | a move counts as ended though its target has had a new life since | **not caught** |
| `slot-table.5` | d01 | first | the source's reopen waits for the row (slot-table.5 as it was) | stall check, d-s-lazy (home down: the writes can finish without it) |
| `slot-table.5` | d03 | second | the source's reopen waits for the row (slot-table.5 as it was), second model | **not caught** |
| `slot-table.5` | d02 | first | the row is never written back after a give-up | stall check, d-s-lazy (home up: and the table names the server) |
| `slot-table.5` | t05 | first | the row is written back on an abort that has not committed | TableRight on d-crash, 11 steps |
| `slot-table.5` | e06 | first | the row is written back to the target, not the source | TableRight on d-core, 7 steps |
| `slot-table.5` | f03 | second | the row is written back to the target, not the source | TableRight on msg-d-core, 5 steps |
| `slot-move.19` | m16 | first | the source reopens on an abort that has not committed | OneTaker on d-crash, 9 steps |
| `slot-move.19` | m17 | first | the source reopens with no abort | OneTaker on d-core, 7 steps |
| `slot-table.1` | m03 | first | the source takes a write after its fence is in its log | PosUnique on d-core, 4 steps |
| `slot-table.1` | u45 | second | the source takes a write after its fence is in its log | NoLoss on msg-d-core, 3 steps |
| `slot-table.1` | n02 | third | a leader takes a write after the fence is in its own log | Views on mem-d-src-core, 4 steps |
| `slot-move.3` | m01 | first | the fence does not stop the source | OneTaker on d-core, 6 steps |
| `slot-move.3` | u44 | second | the fence does not stop the source | OneTaker on msg-d-core, 5 steps |
| `slot-move.3` | n01 | third | the fence does not stop the source | OneServer on mem-d-src-core, 7 steps |
| `slot-move.7` | m02 | first | the final copy's commit does not open the slot | reach goal lost: d-r-moved |
| `slot-move.7` | n14 | third | the final copy's commit does not open the slot | reach goal lost: mem-d-src-r |
| `slot-move.4` | m06 | first | the final copy is sent from a fence that has not committed | OneServer on d-core, 8 steps |
| `slot-move.4` | n06 | third | the final copy is sent from a fence some member holds but no one knows committed | OneServer on mem-d-src-core, 5 steps |
| `stream-numbers.4` | e01 | first | a leader reads the stream table and the sequence from its committed log, not its log end | PosUnique on d-core, 5 steps |
| `stream-numbers.4` | f02 | second | a leader reads the stream table and the sequence from its committed log | InOrder on msg-d-core, 5 steps |
| `stream-numbers.4` | g01 | third | a leader reads the stream table and the sequence from the log it knows committed | PosUnique on mem-d-src-core, 6 steps |
| `slot-move.13` | u28 | second | the target merges a delta onto a copy that stands at another place | InOrder on msg-d-early, 12 steps |
| `slot-move.13` | u29 | second | the source cuts the delta at the wrong place | InOrder on msg-d-early, 10 steps |

### What it shows

- **The decided form holds.** All 53 safety bounds pass, all 15 reach goals are reached, and both stall checks find no stuck state, with the home group down too *(checked)*. That covers every world the three models had, now with one commit in the window and the reopen first: lock tokens, row versions and stamps, the home group down, a membership change, one recovery and two, the carried set sent early, and two member faults with a second election. No property failed, so there is no failing trace to keep.
- **Finding 10: `slot-move.24` must bar the newest move too.** The record says a group never fences, and never takes a final copy, "for a move older than the newest row its log names". A move equal to the newest is not older, so these words let a source fence its newest move a second time. The models' lines say more: a group fences, or takes a final copy, only for a move newer than every move its log names (`fence.newer`, `final.newer`; in the first and third model, `fence.once` and `slot-move.8`). Planted mistake `d06` is the record's words on the fence, with at most two fences of one move: `NoBack` fails in 21 steps on `msg-d-rec-twice` *(checked; [results/finding10-trace.txt](results/finding10-trace.txt))*. The way in: the slot moves to B, a move back to A starts, B fences it and is then recovered, and gives the first move up as lost; A reopens in epoch 2 and takes a write. Then A fences the first move again. Its log end is fenced now, so R10 ("a group that holds the slot open takes no final copy") no longer stops it, and it takes the final copy of the move back from B's old report: A serves in epoch 1 a view older than the one it served in epoch 2.
  - Without a recovery the same words are harmless: `d05`, in the first model, is not caught *(checked)*.
  - For the final copy the words are enough: `d07` is not caught *(checked)*. `d08` replaces `slot-move.8`'s line with the record's first half alone, and a target takes a move's final copy twice: `Views` fails in 11 steps on `d-core` *(checked)*. With the whole record in its place, the second half included ("a group that holds a slot open takes no final copy"), nothing is caught on the 23 `d-` runs of the first model or the 17 `msg-d-` runs of the second *(checked)*. So `slot-move.8` folds into `slot-move.24`, as V5-36 allows.
  - So only the fence half needs the models' words. The ledger now says: "A group fences a slot only for a move newer than every move its log names, and takes a final copy only for a move newer than every fence, final copy and reopen in its log; a group that holds a slot open takes no final copy for it." The second model has run exactly these lines on every bound (`fence.newer`, `final.newer`, `final.shut`), and there `slot-move.8` is spare (`u47`, not caught). Another way would close the case too: the reopen after a lost give-up could name the row it reopens by, so that A's log names a move newer than both *(reasoned; not modelled)*.
- **Without the row written back, only the stall check sees it.** With the reopen first, a row that is never written back breaks no safety property: `d02` passes every small bound and reach check, and only the stall check finds that the table never names the server again (shortest way in: the row commits) *(checked)*. And the old form comes back as a mistake: `d01`, the reopen that waits for the row, is Finding 2 again, a slot that waits for the home group (shortest way in: the row commits, the source fences, the home group goes down) *(checked)*.
- **What the third model says of one commit.** With members, a leader that takes writes behind a final copy or a reopen that only its own log holds keeps every property, with two member faults, a second election, an old leader that still acts and a membership change (`mem-d-src-two`, `mem-d-dst-two`: 5,590,083 and 2,495,799 states), and K-01's reach goal is reached (`mem-d-r-two`) *(checked)*. A write that an old leader takes behind a final copy that never commits is dropped with it. No property sees that, because a writer's answer waits for its own write's commit (`slot-table.2`; answers are not modelled) *(reasoned)*.

### Marks

Each line that now holds a ledger record carries its id, then the line's old short name, so `mutants.txt` stays readable: `\* @rule slot-move.24 fence.newer`. Comments only: the older bounds keep their counts (above).

| Lines (old short name) | Now marked |
|---|---|
| `row.inc write-dst`, `row.inc target` (second model) | `slot-table.8` |
| the fence's `dinc` and the target's check that the fence names it, unmarked before (`f11`, `f12`) | `slot-table.8 fence.inc`, `slot-table.8 fence.to` |
| `recover.shut`, `recover.row`, `recover.epoch`; the reopen on the group's own recovery row, unmarked before (`f04`) | `slot-table.9`; `slot-table.9 own.row` |
| `recover.table`, `recover.final`, `recover.copy` | `slot-table.10` |
| `abort.lost`, `back.lost` (and its `last`, `holder`, `giver`, `top`), `back.epoch`, `unf.wait`, `unf.epoch` | `slot-table.11` |
| `fence.newer`, `final.newer`, `final.shut`; `fence.once` (first and third model) | `slot-move.24` |
| `moved.abort` | `slot-move.23` |
| `ended.back`, `ended.open` (first and second model) | `move-policy.7` |
| `back.committed`; the row written back to the source, unmarked before (`e06`, `f03`) | `slot-table.5`; `slot-table.5 back.src` |
| `delta.base`, `delta.base source`, `delta.*`, `merge.*`; the fence's choice of base, marked `slot-move.12` before | `slot-move.13`; `slot-move.13 fence.base` |
| the guard on the log end, marked `slot-move.1` before | `slot-table.1 slot-move.1` |
| the guard on the committed log, marked `slot-table.1` before | `two-commit`: it held `slot-table.1` as it was; `OneCommit` turns it off |

The source's wait for the ready report was marked `@world slot-move.12 wait`; it is now `@world ready.wait`, since `slot-move.12` no longer has that half.

Some lines keep a mark with no ledger id, because the ledger took no record for them: the source's half of R1 (`row.inc write-src`, `row.inc source`) and the early copy's check (`row.inc copy`), which the models show are spare (`u05`, `u07` not caught); `ended.inc` (`u08`, covered by `slot-table.11`); `copy.forward` (`u43`, harmless); `moved.fence` (no record says whom a fenced source names).

In `mutants.txt` the rule column follows the marks: 42 rows changed: 40 now name a ledger id they did not name before, and `k01` and `n03` now name `two-commit`. The ids and the results they had are as they were; `results/mutants.json` keeps the old names it was run with. In `extra-mutants.txt`, the old text of `f15` follows the new guard line; it is the same change.

## How to run it

```sh
export TLA_JAR=<the tools jar>          # tla2tools.jar
export WORK=<scratch dir>               # optional; default ./target/work
./run.sh                 # all three models: small bounds, reach checks, stall checks: about 5 minutes here
./run.sh big             # also the big bounds
./run.sh big big-all     # one bound by name; msg-* and mem-* names run the second and third model
./run.sh mutants         # every planted mistake; or: ./run.sh mutants m07 c03
./run.sh big x-lock-ver  # a bound of the second reading, by name ("big" runs them all)
./run.sh extra           # the second reading's planted mistakes; or: ./run.sh extra e02 f12
./run.sh decided         # the decided form (card 0002): its small bounds, reach checks and stall checks
./run.sh decided big     # also the decided form's big bounds; one by name: ./run.sh big d-big-ver
./run.sh decided-mutants # the decided form's planted mistakes; or: ./run.sh decided-mutants d01 u24
```

It ends `ok slot-move` or fails. It needs Java 17 or newer and Python 3.

**Pause and resume.** A big bound writes a checkpoint every 10 minutes (`CKPT` sets the minutes) into a folder under `WORK/<name>/meta`. If the run is stopped, by a pause, a restart or the time limit, `./run.sh resume <name>` goes on from the newest checkpoint (TLC's `-recover`). Keep `WORK` on a disk that outlives the stop.

This was tried on `big-all`: stopped after 150 seconds with one checkpoint, then resumed. It ended with the same 1,658,720 distinct states as the run in one piece *(measured)*. One thing had to be fixed for that. TLC picks its fingerprint function at random at each start. A resumed run with another function does not know the states the first part saw: it still ends with the right verdict, but it visits states again and counts too many (1,670,908 in the first try) *(measured)*. So `run.sh` passes the same function to every run (`-fp 31`).

The big bounds of the other two models (`msg-big-*`, `mem-*-two`) write checkpoints the same way. It was tried on `msg-big-rec` too: stopped by the time limit after 150 seconds, then resumed, it ended with the same 1,018,412 distinct states as in one piece *(measured)*. `mem-src-two`, the longest at 15 minutes, ran with checkpoints and was not stopped.

`mutate.py` saves `results/mutants.json` after every mistake, and `./run.sh mutants <id>...` runs only the named ones and merges them in. So a stopped run goes on with the ids that are missing.

## Files

| File | What it is |
|---|---|
| [SlotMove.tla](SlotMove.tla) | the first model |
| [SlotMoveMsg.tla](SlotMoveMsg.tla) | the second model: stored reports, the recovery, the early carried set |
| [SlotMoveMembers.tla](SlotMoveMembers.tla) | the third model: one group with its members |
| [SlotMoveStall.tla](SlotMoveStall.tla) | the model with one derived variable, for the stall check |
| `*.cfg` | one file per bound. First model: `core` to `down` (small), `big-*`, `r-*` (reach), `s-*` (stall). Second: `msg-*`. Third: `mem-*`. Two did not finish and are not run by default: `deep-faults`, `mem-deep-four`. The second reading's bounds have an `x` in their names (`x-*`, `msg-x-*`, `mem-x-*`), and two reach bounds, `msg-r-twice` and `mem-r-back`. The decided form's bounds are `d-*`, `msg-d-*` and `mem-d-*`: each is the world of the bound with the rest of the name |
| [run.sh](run.sh) | reruns everything |
| [stall.py](stall.py) | the stall check, on TLC's printed graph |
| [mutants.txt](mutants.txt), [mutate.py](mutate.py) | the planted mistakes and their runner |
| [extra-mutants.txt](extra-mutants.txt), [extra.py](extra.py) | the second reading's planted mistakes and their runner |
| [decided-mutants.txt](decided-mutants.txt), [decided.py](decided.py) | the planted mistakes of the decided form and their runner |
| [results/](results) | `runs.txt` (every bound's result line), `mutants.md` and `mutants.json`, `extra-mutants.*`, `decided-mutants.*`, the stall checks' output, and the traces of the findings |
