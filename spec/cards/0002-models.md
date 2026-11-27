# Question 2. What the slot-move and founding models found

**Open.** Nine short questions, asked one at a time. Each has a recommendation.

**Blocks:** nothing in slice 0. Questions 1 and 6 change records of slice 1 (`selection.1`, `route-smart.1`). The rest change slices 2 and 3. The ledger is not changed until the answers are in.

## Background

Slice 0 owed two models before the build could plan its later slices. Both are now run, and a second reader checked each one again.

- [models/slot-move](../../models/slot-move/README.md): the slot move in one commit, in full.
- [models/founding](../../models/founding/README.md): founding a resource with several groups.

A few words first. A **slot** is one of the 4,096 buckets a row's key falls into. A **group** is one Raft log with one leader, and it owns some slots. The **home group** is a resource's first group; its log holds the settings and the **slot table**, which says which group owns each slot. A **move** hands one slot from a **source** group to a **target** group. The source writes a **fence** to stop taking writes to the slot. The target then logs the **final copy** of the slot, which opens the slot there. The time between the two, when no group takes writes to the slot, is the **window**. A **recovery** is the operator's repair of a group that lost its majority; the group starts a new life, its **incarnation**.

What the models show *(checked: the model checker ran every state within the stated bounds)*:

- Every bound ends as it should. Slot move: 43 safety bounds pass, 13 reach goals are reached, 3 stall checks end as listed, and the 15 bounds a second reader added end as they should too. Founding: 49 runs end as they should.
- **Planted mistakes** are small changes made on purpose to the model's rules; a good model catches them. The bar is 85 % (DEV-03). Founding catches 79 of 87 (90 %). The slot move's first two models catch 91 % and 86 %. Its third model, one group with its members, catches 62 %, because it uses a short form of Raft. The three together catch 82 %.
- Not finished: two slot-move bounds with four members ran past an hour on this machine. The founding choice in question 8 is shown only up to three groups.
- 53 records whose text the models check as written now name the models in their evidence. The records below wait for your answers.

## 1. Text fixes that add no rule

Each fix below makes a record say what the model needed for a property to hold. None adds a record or changes a count.

| Record | The fix | Why |
|---|---|---|
| `meta-catalog.5` | A group takes up a settings version only once the home log has committed it, and an alter counts a group's take-up only once that take-up has committed. | Otherwise a leader change drops a take-up that was already counted. Mistakes s01, s02. |
| `route-smart.1` (or `slot-table.6`) | A client keeps a slot's row only if it is newer than the row it holds: on `moved`, and on a new link too. | Otherwise a client goes back to an older owner. Mistakes h03, h12, h13. |
| `genesis-conditional-create.4`, `.8` | The founding entry holds the slot table for every group. It applies no seed row of another group's slots; each group opens only its own share and applies its own seed rows. | Otherwise two groups open the same slot, or a row lands in the wrong group. Mistakes f10 to f12. |
| `growth.5` | The group record names the group's first voter. It is written once, and only the machine it names makes the group. | Otherwise a group is made twice, with two logs. Mistakes f06, f07, f21. |
| `selection.1` | A selection over a whole resource is ready only when every slot is covered by a picture, not only when every group's picture has come. | A slot fenced between two pictures is in neither. Probe c-asread. |
| `slot-move.3` | A move is named by the number of its row in the slot table. | No record says what a move's name is. |
| `slot-move.12` | Keep "the target reports where its copy reached" as a rule. "The source fences only after that report" becomes a speed rule. | Only the first half is needed for a property. Mistake u42. |
| `slot-move.13` | The fence names where the last small change set (the **delta**) starts, and the target takes the final copy only if its early copy stands there. | Otherwise a record is applied twice. Mistakes u28, u29. |
| `slot-move.17`, `.16` | The target may give a move up before the fence too; `.16` keeps only "a target that gave a move up drops its unseen copy". | The model's target gives up before the fence, and nothing breaks. |
| `slot-move.22` | Voters are counted in the newest membership in the leader's log, committed or not. | Counted in the committed one, a slot opens in a group of two voters. Mistake n09. |
| `slot-table.6` | A row's version is its number in the home log, then its step; a row written back after a lost target takes a new number. | The order matters exactly when a group recovers. Mistakes u51, u14. |

**Recommended: accept all of them.**

## 2. When the target writes the slot table row

`slot-table.4` says the target writes the row "before it serves the slot". That allows the row before the fence, or inside the window. The model ran only "before the fence". Inside the window the home group's commit sits in the window: three commits in place of one, and a home group that goes down blocks the open *(reasoned, not run)*. With the row first, a target "that has not written the row" never meets a fence, so slot-move.21 never applies.

- **A (recommended):** the row is written before the fence. slot-move.21 is retired or replaced (see question 3).
- **B:** keep the wording open. The other reading then needs its own model run.

## 3. Giving a move up while the home group is down

As written (`slot-table.5`), after a move is given up the row goes back to the source before the source reopens the slot. That needs the home group. With the home group down, 998 of 6,688 states are stuck: the slot takes no writes anywhere until the home group returns.

- **A (recommended): the source reopens first.** The row goes back when the home group answers. No state is stuck (0 of 8,000), and every safety property holds. For a while the table names a target that gave up, so that target answers `moved` and names the source: this sentence replaces slot-move.21. One exception stays: after a recovery has lost the target's data, the source waits for the home group, because only the home log can give the new epoch.
- **B: keep it as written.** The table is exact whenever a slot is served, and a slot can wait for the home group.

## 4. One commit in the window

The move is called "one commit", and the 10 ms bar rests on one commit in the window (E-13: one commit 4.56 ms, two 12.77 ms at p99). As written there are two: the fence commits, then the final copy commits, and only then does the target take a write.

- **A (recommended):** the target takes writes as soon as the final copy is in its log. Those writes sit behind the final copy, so they commit after it. Reads and answers still wait for its commit. This changes `slot-move.7` and `slot-table.1`. The planted mistake that makes this change is not caught on any bound, and that is the evidence it is safe *(checked)*. Reads from an uncommitted tail are not modelled, so reads keep waiting.
- **B:** keep two commits and look at the 10 ms bar again.

## 5. A recovery in the middle of a move

The ledger has one rule for this (`slot-table.7`). The model needs nine. With any one taken away, a property fails in 2 to 24 steps *(checked)*. In short:

- a move's row names both groups' incarnations, and a group acts on a move only in that life;
- after a recovery, the slot stays shut in that group until the home log gives it a row with a new epoch, and only if the table names the group and its copy holds the last final copy;
- a target that gives a move up in a new life says its old data may be lost, and the home group then writes the row back above every other row, at a new epoch, before the source reopens;
- a group never acts on a move older than the newest row its log names, and a group that holds the slot open takes no final copy for it (these two come back in question 6).

- **A (recommended): take the modelled rules.** That is four new records beside `slot-table.7`, about seven rules. Each is checked now.
- **B: the smaller way.** A recovered target gives nothing up, and a slot caught in a move by a recovery waits for the operator. That drops three of the rules. It is reasoned only; a model run comes before it is taken.
- **C: leave it until slice 3 starts.**

## 6. Five more new records

Each one is needed by a property *(checked)*:

- **When a move has ended** (beside `move-policy.4`): the home group starts a slot's next move only once the last move's final copy has committed, or its row has been written back. Mistake t06.
- **Never act on an older move:** a group never fences, and never takes a final copy, for a move older than the newest row its log names; and a group that holds the slot open takes no final copy for it. This holds `slot-move.8` too. Mistakes u24 to u26.
- **A whole selection, three records:** a subscriber takes a picture's part for a slot only at or past its cursor for that slot (c02); a group's picture names the slots it handed off and where each went (c10, c11); a group asked for a slot it has handed off answers END at once and names where it went, and the subscriber turns there (c25, c26).

**Recommended: accept all five.**

**Budget.** With 2 to 6 as recommended, slice 3 goes from 49 records to 58 *(counted: −1 retired, +1 for question 3's sentence, +4, +5)*. Its budget is 54, and 5 % headroom allows 56. So slice 3 passes its budget, and its budget would go to 58. The whole, at 832 records, stays inside its headroom, and so does every layer. If you take B in question 5, slice 3 ends at 57: still over.

## 7. A write that names its settings version

The founding brief asked that a write sent under settings a group has not taken up is refused. No ledger rule does this. The model needs a new field on every write: the settings version the sender holds. A group that is behind sends the write back to be sent again (mistake s09).

- **A (recommended): drop the property.** An alter is answered only once every group has taken it up (`meta-catalog.5`), so a client that waits for the answer never writes ahead of a group. A client that learns the new version some other way before the answer is the gap *(reasoned)*.
- **B:** add the field and the rule (+1 record in slice 2).

## 8. Where a new group's leader lands

As written, `growth.5`, `handback.5` and `handback.6` make the founder's machine the preferred member of every group, against `move-policy.6` (probe f-aswritten). Two ways out were modelled:

- **A:** an exception in `handback.5` when a new group writes its first full placement. It holds up to three groups, and fails with four groups on four machines (probe f-many).
- **B (recommended): the group record names the quietest machine as first voter.** `handback.5` and `.6` stay. It holds up to three groups. The four-group run ran out of memory here, so B must be run on a bigger machine before slice 2.

## 9. `slot-move.22` on one machine

"No slot opens in a group with fewer voters than the copies setting." On one machine with copies 3, no slot ever opens (probe f-onebox). That goes against `open.8` (a solo node is the only voter of its groups) and `genesis-conditional-create.7` (a one-box id is a real founding).

- **A (recommended):** a group opens with fewer voters when the resource has fewer machines than its copies setting, and grows when machines come.
- **B:** the rule is only for a new group of a growing resource (the case V5-18 pick 7 was about).

## Owed work, whatever the answers

- The slot move's members model must reach 85 %, and a voter added while a member is down must finish; both need a bigger machine.
- Founding's selection model keeps one store per client, so "no row shown twice" is assumed there, not checked; it needs rows per group.
- A move with the home group down, and a move in two steps, in the founding model's row 2.
