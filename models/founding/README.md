# Founding with several groups: four models

A model study. No product code. It follows the shape of [probes/p5](../../probes/p5/README.md): TLA+ models, one `.cfg` per bound, `run.sh`, planted mistakes in `mutants.txt`, results in `results/`.

Each claim below is marked: *(counted)* from the ledger or the record, *(checked)* by the model checker on every reachable state at the stated bounds, *(measured)* a time or a state count from a run here, or *(reasoned)* argued and not run.

## The question

Every resource is founded with several groups from the first build (V5-18 pick 1). A **group** is one Raft log with one leader; it owns some of a resource's **slots** (the 4,096 hash buckets a row's key falls into). The **home group** is a resource's first group; its log holds the settings, the slot table and one record per group.

The study's page on many groups (GROUPS.md, section 4.2) owes five models or measures before the first slice can be built. This folder holds the four that are models:

| Row | What it settles | Model here | Built on |
|---|---|---|---|
| 1 | settings taken up per group, with an alter and the read-only gate (S1, part of O7) | [Settings.tla](Settings.tla) | E-51's catalog model |
| 2 | a client that first reaches another group's copy, with the home group down (H1) | [HomeRecords.tla](HomeRecords.tla) | E-51's client model |
| 3 | founding with a pre-split, placed by load, the preferred member on another machine (H9's pre-split, H7) | [Found.tla](Found.tla) | E-51's founding model, E-52's placement |
| 4 | one selection over a whole resource with two groups, a move each, one group down (P4, P5) | [Selection.tla](Selection.tla) | E-31 |

Row 5 (the cost of a whole-resource store on real links) is a measure, not a model. It is left out here.

The study's models for E-51, E-52 and E-31 are Python, on the study's own engine. Their worlds are written again here in TLA+, as P5 did for its models. Each world is cut down to what its row needs; "What the models leave out" says what went.

## In short

1. **The four designs hold** at every bound run, once row 4 has the rule of finding 10: 28 complete runs, 20 small and 8 big, and no property fails *(checked)*. All 11 reach goals are reached, and on 5 small bounds, at least one per model, the design can still finish from every judged state *(checked)*. The biggest run is 21,511,833 states in 444 s; the longest is 792 s *(measured)*. Every run is under the hour. The big bounds were run a second time on a busier box: the same state counts, the longest 1,592 s *(measured)*.
2. **79 of 87 planted mistakes are caught**, 90 % *(checked)*. DEV-03's bar is 85 %. The first 58 were planted when the models were written (56 caught then). The other 29 were planted on a second pass, many on lines that had no mark before.
3. **The models needed rules the ledger does not hold, and four ledger texts are wrong or loose as they read** (`selection.1`; `genesis-conditional-create.4`; `slot-move.22`; `handback.5` beside `move-policy.6`). Eleven findings are in "What the models found"; findings 10 and 11 came from bounds added on a second pass (a slot that moves back; more groups than copies). The ledger changes they ask for are in "Ledger changes proposed". None is applied here.
4. **After card 0002** the owner took every recommended option (V5-33 to V5-39). Way B holds with four groups on four machines, `SpreadEven` too, on 6,328,888 states *(checked)*. A switch runs `slot-move.22` as the owner decided it for fewer machines than copies: one and two machines open every slot, a third machine that comes later is taken in, and a group that shrinks does not open early *(checked)*. It needs `growth.1` and `growth.2` to place and grow to every machine when there are fewer than three, and way B's group record no longer waits for three machines. Two costs: in a founding race a slot can open and take writes with one copy before the other machines take up the id, and a group record written before they come names the founder's machine *(checked)*. See "After card 0002", which also gives the text for `slot-move.22`.

## How a model is checked

Four kinds of check, the same in every model:

- **Safety.** Properties on committed state, checked on every reachable state.
- **Reach.** A check that says "the goal is never reached". TLC must find it violated: the trace it prints is a run that reaches the goal. So a model that cannot do anything cannot pass.
- **No stuck state.** In each model `Calm` is the steps of the design itself: no fault, no operator, no new work. `NoStuck` says: with everything up, a state where no calm step can run is a finished state.
- **Always can finish.** From every judged state, calm steps alone can reach a goal state. The study calls this AG EF. TLC cannot check it by itself, so `<Model>Live.tla` adds a tag to each state, TLC writes the whole state graph, and [agef.py](agef.py) walks it back from the goals. It runs on one small bound per model, and on two for row 4.

Lines marked `\* @rule <id>` in a model hold the rules. The id is the ledger record the line stands for. Until card 0002, an id that started `new:` was a rule the ledger did not hold yet; since the owner's answers every such line names its record, or a `line:` name where the owner dropped the rule (see "After card 0002"). A name that starts `line:` marks a line that is part of how a rule is carried out and has no ledger id of its own. `mutants.txt` plants one-line mistakes on these lines.

## Row 1: settings per group ([Settings.tla](Settings.tla))

**The world.** A home group and one or two other groups. Each is an abstract Raft group: a log, a commit index, a tail that a leader change may drop. A group may lose its majority and come back. The operator makes alters; each one may set the **gate** (the resource's write gate) read-only or open. One client learns a settings version from any copy and sends writes that name it.

**The rules.** An alter is one entry in the home log (`meta-catalog.2`). Each other group takes a version up by an entry in its own log, and the alter is answered only once every group has (`meta-catalog.5`). A group whose log holds a read-only gate refuses every write (`meta-catalog.4`). A leader judges a write at its log end (`writer-judging.1`) and sends a refusal only once what it rests on has committed (`writer-judging.2`).

**The properties.**

| Name | What it says |
|---|---|
| `Same` | every group takes up only versions the home log committed, with the same gate |
| `InForce` | an answered alter has been taken up, for good, by every group |
| `GateGroup` | no write commits in a group after a read-only version in that group's log |
| `GateAll` | once a read-only alter is answered, no write commits in any group until a later alter commits |
| `JudgeOrder` | a write is judged under the version its group had taken up before it |
| `AsMade` | no write is judged under settings older than the ones its sender held |
| `RoTrue`, `Told` | "read-only" and "ok" are told only for what committed |
| `NoStuck` | with every group up, nothing is left hanging |

## Row 2: the home records on every copy ([HomeRecords.tla](HomeRecords.tla))

**The world.** One slot. A home group and one or two other groups, each with a leader copy and a follower copy that is behind until it catches up. A slot move is one step here (the move has its own model in another stage). Groups go down: then none of their copies answers. The directory may hand the client any copy: a dead one, a follower that is behind, or a server of another resource that took a dead address.

**The rules.** Every copy keeps the home records (`home-records.1`): a group's leader follows the home log and writes what it reads into its own log, and a follower gets it with that log. Any copy hands out what it has, maybe old (`home-records.2`). A leader takes a write only for a slot its own log holds open (`slot-table.1`), else it answers "moved" and names the owner it knows (`slot-table.3`). The client checks the resource (`soft-directory.8`), keeps only a newer row (`slot-table.6`), follows "moved" (`route-smart.1`), never takes "no answer" as final (`route-smart.2`), and asks the directory again once the member it knew failed (`soft-directory.9`). A copy forwards, follows "moved" itself, or refuses at once with a redirect (`route-forward.1`, `route-forward.2`).

**The properties.**

| Name | What it says |
|---|---|
| `Right` | the write commits only in the group that holds the slot |
| `TrueOk` | "ok" is told only for a write that committed in this resource |
| `Forward` | the client takes at most one row per epoch: it never goes back to an older row |
| `NoRepeat` | a "moved" answer always moves the client on: it never writes again by a row whose group said "moved" |
| `NoFuture` | no copy holds a row newer than the truth |
| `NoStuck` | while the owner's group is up, the write is never dropped or held |
| always can finish | from every state where the owner's group is up, the write can still commit |

The reach checks ask for the row's own case: the home group was down before the client's first link, that link was to another group's copy, and the write committed (`h-reach`); the same with a follower as the first copy and two moves behind it (`h-reach-far`); and the same where that first copy's group is not the group that holds the slot (`h-reach-other`).

## Row 3: founding with a pre-split ([Found.tla](Found.tla))

**The world.** Three to five machines that go down and come back with their disks. An object store with create-if-absent. Groups are abstract Raft groups: a group works while its leader and a majority of its voters are up. Only committed state is kept.

**The rules.** Founding is the study's four steps (`genesis-conditional-create.1` to `.6`): write a candidate id to disk, ask the store to create it, found only if the stored id is your own, else drop it and adopt. The founder makes the home group with itself as the only voter (`.4`). Its first entry holds the slot table for every group the size hint asks for (`.8`). The home group's leader writes a group record per other group, and the machine the record names makes that group (`growth.5`). Each group writes a placement of `Copies` machines, the quieter ones first (`growth.1`, `healing-self.16`, `healing-self.19`), grows to them (`growth.2`), and only then opens its share of the slots (`slot-move.22`). Leadership goes to the preferred member, only if it is a voter (`handback.1`, `handback.2`). After card 0002 a switch, `Fewer`, also runs `slot-move.22` as the owner decided it for a resource with fewer machines than `Copies` (V5-39); see "After card 0002".

Two ways to spread the groups are modelled, because the ledger's own rules do not spread them (finding 5):

- `FirstVoter = "creator"`, `PrefByLoad = TRUE`: the home group's leader is each group's first voter, as `growth.5` reads; when a new group writes its first full placement it names as preferred member the placed machine that should lead the fewest groups.
- `FirstVoter = "quiet"`: the group record names the machine that was named for the fewest groups, and that machine makes the group. `handback.5` and `handback.6` then hold as written.

**The properties.**

| Name | What it says |
|---|---|
| `OneHome` | one resource is founded at most once under one name |
| `OneId` | every copy holds the stored id |
| `OneLog` | each group is made once: one log, one first voter |
| `OnceSlot` | a slot is open only in the group the table names, so in one group |
| `AllVoters` | no slot is open in a group that lacks its voters |
| `WriteRight` | a write commits only in the group the table names for its slot |
| `SeedOnce` | each slot's seed rows land once, in the group that holds the slot, before any write to it |
| `LeadVoter`, `VoterHas`, `PrefPlaced` | a leader is a voter, a voter holds the log, the preferred member is placed |
| `Spread` | no machine is the preferred member of two fully placed groups (bounds with no crash) |
| `Even` | the machines that did not make the groups hold about the same number of copies (bounds with no crash) |
| `SpreadEven` | with more groups than a placement has machines: no machine is the preferred member of two more groups than another (only on `f-many`, finding 11) |
| `NoStuck` | with every machine up, founding finishes |

## Row 4: one selection over two groups ([Selection.tla](Selection.tla))

**The world.** Groups A and B. Slot s1 starts in A, s2 in B. A slot's log is a counter: record n makes the slot's value n, so a record taken twice or skipped shows. A move is a fence at the old group, then an open at the new one. A slot moves once, to the other group; on the `c-back` bounds it may then move back. A group may go down; a link may drop alone. A link carries frames in order.

**The rules.** A selection over the whole resource is one subscription per group (`selection.1`). A group answers with a picture of the slots it holds, each at its own position (`subscribe.1`, `subscribe.3`), then each later committed record (`subscribe.5`, `subscribe.6`). At a move the old group ends the slot with END at the fence and names the new group; the client asks the new group for the slot (`subscribe.29`), and the new group answers only once the slot is open there (`slot-move.9`, which the ledger writes for writes; here it stands for an ask). A group asked for a slot it has handed off answers END and names where the slot went (`subscribe.40`, finding 10). The client keeps one store with a cursor per slot: a picture sets the rows and the cursor (`subscribe.12`, `subscribe.13`), and a record is taken only if it is the next one, once (`subscribe.14` to `.16`).

**The properties.**

| Name | What it says |
|---|---|
| `Exact` | what the client shows for a slot is that slot's committed log at the client's cursor: no record twice, none skipped, nothing uncommitted |
| `NoBack` | a cursor never goes back |
| `Whole` | a ready selection covers every slot: no slot falls between two pictures |
| `Waits` | while a group is down the selection is not ready (`selection.6`) |
| `NoStuck` | with both groups up, the selection ends ready and level with every slot |

The reach checks ask for the row's own case: both slots moved, one group went down and came back, and the selection is ready and level (`c-reach`); and the same where both slots moved away and back (`c-back-reach`).

## What ran

49 runs, each its own bound and its own line in [results/runs.txt](results/runs.txt) *(measured: 2 TLC workers on a shared 4-core box)*. "States" is the distinct states TLC found. For a run that holds, that is every reachable state. A reach run or a probe stops at its first trace, so its count is only how far it got, and it changes a little from run to run. With two workers the depth TLC reports can be one more than the true depth.

- A bound that **holds**: every property of its model, on every reachable state.
- A **reach** bound: the goal is reached, shown by a trace.
- **Always can finish**: checked on the whole graph by `agef.py`.
- A **probe**: a bound that must fail, and does; its finding says what the failure shows.

The rows in bold are the big bounds (`./run.sh big`).

**Row 1, `Settings`**

| Bound | The world | Result | States | Depth | Seconds |
|---|---|---|---|---|---|
| `s-small` | 1 other group, 1 alter, 1 write, 1 leader change | holds | 520 | 14 | 1 |
| `s-two` | 2 other groups, 1 alter, 2 writes, 1 leader change, 1 group down | holds | 200,225 | 22 | 7 |
| `s-alter2` | 1 other group, 2 alters, 2 writes, 1 leader change, 1 group down | holds | 840,096 | 26 | 28 |
| `s-reach` | reach: 2 other groups, both alters answered, the write committed | goal reached | 79,297 | 15 | 4 |
| `s-reach-ro` | reach: a write is refused read-only | goal reached | 175 | 9 | 1 |
| `s-reach-behind` | reach: a write is sent back as "behind" | goal reached | 104 | 7 | 0 |
| `s-live` | always can finish: 1 other group, 1 alter, 1 write, 1 leader change, 1 group down | can finish from all 1,647 judged states | 3,487 | 15 | 2 |
| `s-early` | probe: early answers on (finding 3) | `EarlyKept` fails, as the finding says | 388 | 9 | 1 |
| **`s-big`** | 2 other groups, 2 alters, 2 writes, 1 leader change, 1 group down | holds | 10,337,625 | 30 | 792 |

**Row 2, `HomeRecords`**

| Bound | The world | Result | States | Depth | Seconds |
|---|---|---|---|---|---|
| `h-small` | 1 other group, 1 move, the home group down for good | holds | 4,848 | 21 | 1 |
| `h-foreign` | 1 other group, 1 move, either group down once and back, another resource's server | holds | 21,053 | 23 | 1 |
| `h-pre` | 2 other groups, the slot starts outside the home group, 1 move, the home group or g2 down | holds | 216,831 | 24 | 6 |
| `h-reach` | reach: home down first, first copy of another group, the write commits | goal reached | 841 | 8 | 1 |
| `h-reach-far` | reach: the same, a follower first, 2 moves behind it | goal reached | 397,504 | 12 | 7 |
| `h-reach-other` | reach: the same as `h-reach`, the first copy's group does not hold the slot | goal reached | 1,208 | 6 | 2 |
| `h-live` | always can finish: 2 other groups, 1 move, the home group down for good | can finish from all 74,557 judged states | 75,010 | 26 | 9 |
| **`h-two`** | 2 other groups, 2 moves, the home group down for good, another resource's server, 2 forward hops | holds | 4,290,944 | 33 | 84 |
| **`h-big`** | 2 other groups, the slot starts outside the home group, 2 moves, any group down once and back | holds | 21,511,833 | 41 | 444 |
| **`h-down2`** | 2 other groups, the slot starts outside the home group, 1 move, two outages: the home group down for good and another group down and back, or one group down twice | holds | 1,415,694 | 28 | 90 |

**Row 3, `Found`**

| Bound | The world | Result | States | Depth | Seconds |
|---|---|---|---|---|---|
| `f-small` | 3 machines, 2 groups, 2 slots, no crash | holds | 362 | 17 | 1 |
| `f-crash` | 3 machines, 2 groups, 2 slots, 1 crash | holds | 3,412 | 21 | 2 |
| `f-crash2` | 3 machines, 2 groups, 2 slots, 2 crashes | holds | 12,786 | 23 | 8 |
| `f-homefirst` | as `f-crash`, the home group opens its share in the first entry | holds | 3,637 | 20 | 1 |
| `f-four` | 4 machines, 3 groups, 3 slots, no crash | holds | 125,632 | 25 | 18 |
| `f-quiet` | first voter by load: 4 machines, 3 groups, 3 slots, no crash | holds | 125,704 | 23 | 20 |
| `f-quiet-crash` | first voter by load: 3 machines, 2 groups, 2 slots, 1 crash | holds | 2,098 | 19 | 1 |
| `f-quiet-load` | reach, first voter by load: 5 machines, 3 groups, done with no machine in every group | goal reached | 444,262 | 18 | 80 |
| `f-reach` | reach: founding completes, with a crash on the way allowed | goal reached | 2,466 | 17 | 1 |
| `f-reach-spread` | reach: 3 groups, done, each led from another machine | goal reached | 3,102 | 24 | 2 |
| `f-live` | always can finish: 3 machines, 2 groups, 2 slots, 1 crash | can finish from all 2,567 judged states | 5,087 | 21 | 2 |
| `f-aswritten` | probe: the preferred member as the ledger reads (finding 5) | `Spread` fails, as the finding says | 145 | 10 | 0 |
| `f-onebox` | probe: one machine (finding 6) | `NoStuck` fails, as the finding says | 6 | 6 | 1 |
| `f-many` | probe: way A with 4 machines, 4 groups, 4 slots, no crash (finding 11) | `SpreadEven` fails, as the finding says | 121,916 | 17 | 55 |
| **`f-big`** | 4 machines, 3 groups, 3 slots, 1 crash | holds | 2,916,816 | 29 | 606 |
| **`f-load`** | 5 machines, 3 groups, 1 slot, no crash: the maker's machine holds a copy of every group (4 properties only: `OneHome`, `OneLog`, `Spread`, `MakerHoldsAll`) | holds | 411,782 | 22 | 122 |

**Row 4, `Selection`**

| Bound | The world | Result | States | Depth | Seconds |
|---|---|---|---|---|---|
| `c-small` | 1 record a slot, s1 moves, no fault | holds | 1,092 | 18 | 0 |
| `c-move` | 2 records a slot, s1 moves, 1 link drop, 2 frames a link | holds | 50,555 | 27 | 2 |
| `c-down` | 1 record a slot, both slots move, 1 group down | holds | 94,346 | 29 | 4 |
| `c-both` | 1 record a slot, both slots move, 1 group down, 1 link drop | holds | 291,596 | 31 | 6 |
| `c-down2` | 1 record a slot, both slots move, 2 group outages | holds | 244,907 | 31 | 22 |
| `c-back` | 1 record a slot, s1 moves and moves back, no fault | holds | 8,110 | 32 | 4 |
| `c-back-drop` | 2 records a slot, s1 moves and moves back, 1 link drop, 2 frames a link | holds | 626,505 | 40 | 53 |
| `c-reach` | reach: both slots moved, a group was down, the selection is ready and level | goal reached | 40,334 | 15 | 1 |
| `c-back-reach` | reach: both slots moved away and back, a group was down, the selection is ready and level | goal reached | 300,444 | 17 | 27 |
| `c-live` | always can finish: 1 record a slot, s1 moves, 1 group down | can finish from all 9,075 judged states | 12,936 | 22 | 3 |
| `c-back-live` | always can finish: 1 record a slot, s1 moves and moves back, 1 group down | can finish from all 53,504 judged states | 70,509 | 34 | 22 |
| `c-asread` | probe: ready per group only (finding 8) | `Whole` fails, as the finding says | 500 | 9 | 1 |
| **`c-big`** | 2 records a slot, both slots move, 1 group down, 1 link drop, 2 frames a link | holds | 4,140,146 | 39 | 182 |
| **`c-back-down`** | 1 record a slot, both slots move and move back, 1 group down | holds | 6,370,476 | 56 | 394 |

## What the models found

Each finding names the property that fails. For a probe (a bound that must fail), the run TLC printed is in [results/traces.txt](results/traces.txt). For a planted mistake, [results/mutants.md](results/mutants.md) names the bound that caught it and the length of the run. With two workers a run may be a step or two longer than the shortest one.

**1. A group may take up only what the home log has committed, and the alter may count only a take-up that has committed** (row 1). `meta-catalog.5` says neither. Planted out, a group takes up an alter that a home leader change then drops (`Same` fails), and an alter is answered on a take-up that is then dropped (`InForce` fails) *(checked: mistakes s01, s02)*. That every group is waited for is needed too *(checked: s03, s05)*.

**2. "A write under settings a group has not taken up is refused" has no rule** (row 1). The model adds one, the line `line:settings-behind` (marked `new:settings-behind` until card 0002): a write names the settings version its sender holds, and a group that is behind sends it back to be sent again. Without it nothing else holds the property (`AsMade` fails) *(checked: s09)*. It is a new field on a write, so it is the owner's call: take the rule, or drop the property. The owner dropped the property (V5-37). The line and `AsMade` stay in the model, so its runs and mistakes s09, s10 stay as they were; no ledger record stands behind them.

**3. An early answer can still be followed by a refusal, on one group, with no move** (row 1, the part of O7 this row holds). A write is told `received`, a leader change drops it, the gate goes read-only, the client sends it again, and it is refused (`s-early`: `EarlyKept` fails, a run of 8 states) *(checked)*. The early answer stages are built after the first build and have no ledger record, so this is a note for then: a write that the gate can refuse is a write that can be refused.

**4. The home records on every copy do what V5-18 pick 6 asks** (row 2). With the home group down, a client whose first copy is another group's reaches the owner and commits *(checked: `h-reach`, `h-reach-far`)*, and can always do so while the owner's group is up *(checked: `h-live`)*. The records must be kept: a follower or a leader that knows only its own group's log leaves the client with no way on (cannot finish from 732 judged states) *(checked: h06, h07)*. Two readings the model had to take, since the ledger leaves them open: a group's leader copies the home rows into its own group's log, so followers get them in log order; and a client keeps a row only if it is newer than the one it holds (`Forward` fails without it) *(checked: h03)*.

**5. The ledger's rules put every group's leader on one machine** (row 3; this is H7, now shown). By `growth.5` the home group's leader is each new group's first voter. By `handback.6` the first voter named is the preferred member, and by `handback.5` it stays so while it is placed. So the founder's machine is the preferred member of every group, against `move-policy.6` (`f-aswritten`: `Spread` fails, a run of 10 states) *(checked)*. Both ways out hold every property *(checked)*: an exception to `handback.5` at a new group's first full placement, or a group record that names the quietest machine as first voter. With the first way the machine that makes the groups still holds a copy of every one of them, always (`f-load`: `MakerHoldsAll`) *(checked)*; with the second it need not (`f-quiet-load` reaches a founding where no machine holds every group) *(checked)*.

**6. `slot-move.22` as it reads stops a resource on one machine** (row 3). "No slot opens in a group that has fewer voters than the resource's `copies` setting": with one machine and `copies` 3 no group ever gets its voters, so no slot ever opens (`f-onebox`: `NoStuck` fails, a run of 6 states) *(checked)*. The ledger also says a solo node is the only voter of its groups (`open.8`) and a one-box id is a real founding (`genesis-conditional-create.7`). In the other reading the model checks (`f-homefirst`: the home group opens its own share in its first entry) the home group's slots would open on one machine, and the other groups' still would not *(reasoned)*. The rule needs a word on one box. This is a question for the owner, not a proposal: see the end of "Ledger changes proposed".

**7. The pre-split needs three things said** (row 3). (a) The slot table for every group is in the founding entry, and a group opens only its own share: a home group that opens every slot at founding holds slots that another group opens too (`OnceSlot`) *(checked: f10, f11)*. (b) The seed cannot all be applied by the first entry, as `genesis-conditional-create.4` reads: rows of slots that belong to other groups would land in the home group (`SeedOnce`) *(checked: f12)*. Each group's open applies the seed rows of its own slots. (c) Only the machine a group record names makes the group, and only once; else a group is made twice, with two logs (`OneLog`) *(checked: f06, f07)*.

**8. "Ready when every group's picture has come" misses a slot** (row 4). The client asks B; B answers with a picture of s2. s1 is then fenced at A. A answers with a picture taken after the fence: no s1. Both pictures have come, and no picture holds s1 (`c-asread`: `Whole` fails, a run of 8 states) *(checked)*. `selection.1` must also ask that every slot is covered.

**9. A whole selection needs three client and server rules the ledger does not hold** (row 4). (a) A picture's part for a slot is taken only at or past the client's cursor for that slot. Without it a late picture from the old group takes the slot back in time (`NoBack`) *(checked: c02)*. (b) A group's picture names the slots it handed off and where each went. Without it a client whose pictures both miss a slot (finding 8's run), or that lost the END frame with a dropped link, never learns where the slot went and stays without it for good (`NoStuck`) *(checked: c10)*. (c) The client asks the new group for such a slot unless it already takes the slot from there, also for a slot it never held (`NoStuck`) *(checked: c11)*.

**10. A slot that moves back leaves a whole selection stuck, unless a group answers an ask for a slot it has handed off** (row 4). The first form of this model moved each slot once. With a move back, the client is told s1 went to B and asks B. Before B answers, s1 opens at B and moves on, back to A. The ask now waits at B for a slot B will not hold again, and nothing tells the client (`NoStuck` fails, a run of 12 states) *(checked: c25)*. Two halves of one rule are added, now `subscribe.40`: a group asked for a slot it has handed off answers END at once and names the group the slot went to; and a client that gets END from the group it asked turns to the group named. Without the second half the client cannot always finish *(checked: c26, on `c-back-live`)*. With both, every `c-back` bound holds and the client can always finish *(checked)*. An old END or an old picture can still send the client one trip the wrong way; the next END brings it back, which is why c24 is not caught.

**11. Way A stops spreading the leaders once a resource has more groups than copies** (row 3). Every other bound has at most 3 groups and 3 copies, so each placement holds a machine that leads nothing yet. With 4 groups on 4 machines, all there from the start, way A can end with the founder's machine as the preferred member of two groups and one machine that leads none (`f-many`: `SpreadEven` fails, a run of 17 states) *(checked)*. The cause: a placement is picked by copies held, with ties broken any way, and the preferred member is picked only inside the placement. The fourth group's placement can leave out the one machine that leads nothing. So finding 5's "both ways hold" is shown only for as many groups as copies. `Spread` itself cannot hold when the groups outnumber the machines that are there; `SpreadEven` is the property for that case. Way B on the same bound did not finish here: the run was stopped by the box for lack of memory at about 2.2 million states, with no failure up to there. It is not counted. After card 0002 it was run again, alone and with more memory, and it holds: `SpreadEven` too, on 6,328,888 states (`f-quiet-many`, see "After card 0002") *(checked)*.

Also seen, smaller:

- The first two reach checks of row 2 are reached by runs whose first copy sits in the group that holds the slot. `h-reach-other` asks for a first copy in a third group: the home group is down, the first link is to a follower of g2, and the write commits in g1 (a run of 5 states) *(checked)*.
- A client must keep "only a newer row" wherever it takes a row: on a new link too *(checked: h12)*, not only on `moved` *(checked: h13)*.
- A group record that a later home leader writes again, naming itself, makes the group a second time (`OneLog`) *(checked: f21)*. The record is written once.
- With one fault more than the first bounds had, the designs still hold: two machine crashes at founding (`f-crash2`), the home group down for good and then another group down and back (`h-down2`), two group outages under a whole selection (`c-down2`) *(checked)*.

- A machine that opens the resource after the placements were written gets no copy at founding *(checked: the first form of `Even` failed; it is now judged only when every machine was there)*. Spreading to it later is the move policy's work.
- An alter waits for every group, so one group without a majority holds every alter back, the read-only gate too *(reasoned from `meta-catalog.5`; in the model no alter is answered while a group is down)*.

## Planted mistakes

`mutants.txt` holds 87 one-line mistakes on the marked rule lines (and ten more, d01 to d10, for the decided form of "After card 0002", counted apart): a guard dropped, a comparison flipped, an update dropped or weakened, the wrong place read. `mutate.py` plants each in a copy of its model and runs the small bounds, then the reach bounds, then the "always can finish" bound. The table of every one is [results/mutants.md](results/mutants.md).

| Model | Mistakes | Caught |
|---|---|---|
| Settings | 15 | 14 |
| HomeRecords | 17 | 15 |
| Found | 29 | 27 |
| Selection | 26 | 23 |
| **All** | **87** | **79 (90 %)** |

*(checked; DEV-03's bar is 85 %)*. 55 are caught by a safety property, 16 by `NoStuck`, and 8 only by the "always can finish" check *(counted)*. The longest single run that ended took 321 s *(measured)*. One run did not end: f27 on `f-quiet` was stopped at a 900 s limit and is not counted; f27 is caught on the next bound, `f-four`. The row 4 mistakes were all planted again after the model got the move back; the others stand from their own pass.

The 8 that are not caught:

- **h08**, a follower hands out only its copy of the home records, never what its own group's log knows. The client starts from an older row, is told "moved" once more, and still arrives. It costs a trip, and no property here counts trips. Equal for these properties *(checked: every bound holds and the client can always finish)*.
- **h17**, "no answer" is not counted as a failure of the member. The client still learns of the failure another way (its link's copy is down, or a forwarding copy says the group is down), so it can always finish. Equal for these properties *(checked)*.
- **c07**, END names the old group. It was caught before the rule of finding 10 was there. Now the old group answers the ask with an END that names the right group, and the client arrives one trip later. Equal for these properties *(checked)*.
- **c16**, a group answers an ask for a slot it does not hold. It answers with the fence it remembers, then ends the slot again, and the client turns to the right group. Equal for these properties *(checked)*. Rows per group are not modelled (see "What the models leave out"), so a wrong row in such an answer would not show.
- **c24**, any END turns the client, an old one too. The client goes one trip the wrong way and the next END brings it back. Equal for these properties *(checked)*.
- **s15**, a first send names no settings version. `AsMade` reads the version the write names, so a write that names none passes it. A real hole in the property: it holds only for a client that names its version truly.
- **f28**, a group grows to machines that do not answer. The model does not keep what a new voter holds, so nothing sees it. A real hole: `growth.2` is in the model but not checked by it.
- **f29**, leadership is handed to a preferred member that is down. The group then elects again and founding still finishes; the model only loses time. Not shown harmless beyond that.

Three more lines are probes, changes the design says are harmless in these worlds. None is caught, as expected *(checked)*: END sent before the last records below the fence (x01: in state mode the new group's picture replaces them); a record past the next one taken (x02: no stream here has a gap); a row of the same epoch taken again (x03: it is the same row).

## What the models leave out

- **Row 5**, the measure on real links.
- **Raft itself.** A group is a log with a commit index (row 1) or committed state only (rows 2 to 4). Elections, terms and lost tails inside a group are the Raft port's and P5's.
- **The slot move.** In row 2 a move is one step; in row 4 it is a fence and an open with no copy, no give-up and no carried set. The move has its own model in another stage. Row 2 has no move while the home group is down, and no move that is given up.
- **Code hashes, the roll and the cross-key check.** E-51's catalog model covers them (`meta-catalog.1`, the roll half of `meta-catalog.2`, `meta-catalog.3`). Row 1 keeps the alter, the take-up and the gate; an alter's content is its gate and its version number.
- **Lost disks, two resource names and the settings an opener passes.** E-51's founding model covers them (wipes, isolation between names, a later open with other options). Row 3 keeps crashes with the disk kept.
- **The directory's own rules** (announce, expire, take over). E-51's table model covers them. Row 2 lets the directory hand out any copy.
- **Members and leader hints in the home records.** Row 2 keeps the slot table row; "the group's leader" stands for the hint.
- **Learners and promotion one by one, retiring machines, a placement that changes later.** E-52's and E-59's. Row 3 grows a group from one voter to all its placed machines in one step.
- **Load as a number.** Row 3 counts copies and leaderships; memory and write rate are not there.
- **Log mode, credits, relays, a client's own write.** E-31's. Row 4 is state mode: a picture, then records.
- **How a client notices a dead link.** In row 4 a down group's link is seen dropped at once.
- **Rows per group.** In row 4 a slot has one true log. A group that holds the slot answers with the true position, and a group that does not answers with the fence it remembers. What a picture's rows are, beside its position, is not modelled, so "a row shown twice" is ruled out by the one store with one cursor per slot, not by a check of rows.
- **Two groups down at once, and more than two machine crashes.** No bound has them.
- **`growth.2` and the "live" half of `handback.1`.** The lines are in row 3, but no property sees them (f28, f29).
- **How the home group's leader hears that a group has taken a version up.** Row 1 lets it read the groups' committed logs. A late report is safe, since a take-up is never undone *(reasoned)*.
- **Ledger records this stage looked at and did not model again:** `meta-directory.1` to `.7` (the group records written again, incarnations, deletes), `meta-members.1` and `.2` (retiring), `soft-directory.1` to `.7` and `.10` to `.13`, most of `healing-self`, `genesis-conditional-create.7` (one box). E-51 and E-52 hold their models; nothing here changes them, but nothing here checks them with several groups either.
- **Livelock.** "Always can finish" shows a way to the goal exists from every judged state. It does not show that a client that picks badly for ever gets there.

## After card 0002

The owner took the recommended option on all nine questions of card 0002 (V5-33 to V5-39). Three things in this folder follow from that: a switch in [Found.tla](Found.tla) for question 9 (V5-39), way B with four groups for question 8 (V5-38), and the marks.

### The switch: fewer machines than copies (V5-39)

V5-39: a group opens with fewer voters than the copies setting when the resource has fewer machines than that, and grows as machines come. Found.tla gets a constant `Fewer`:

| `Fewer` | When a group may open its slots | How a group grows | Used by |
|---|---|---|---|
| `"no"` | with `Copies` voters (the reading before card 0002) | a placement of `Copies` machines, then from one voter to all of them in one step | every `f-` bound, as before |
| `"every"` | with `Copies` voters, or with as many as the resource has machines when it has fewer (the decided reading) | a placement names every listed machine while fewer than `Copies` are listed, and is written again, keeping the voters, when more come; the group grows to all its placed machines | the `fd-` bounds: the decided form |
| `"three"` | as `"every"` | as `"no"`: the growth rules as the ledger writes them | the probe `fd-two-three` |

With `Fewer = "no"` every `f-` bound keeps its state count *(checked: the rerun below)*. `f-onebox` still fails, as the probe of the old reading.

**What "the resource's machines" is.** A leader must be able to count them, and the count must not drop when a placed machine goes down. If it did, a group that lost a voter could open on a resource that has enough machines, the case `slot-move.22` was written for. The model counts the machines in either of two sets that a leader already holds:

- the **listed** machines: up and holding the resource, the ones the leader may place a copy on (`healing-self.16`, `.19`; the soft directory);
- every machine a **stored placement** names, of any group, up or down. A group's own placement is in its own log. Another group's placed machines are in the home records as that group's members (`home-records.1`), since `growth.1` adds every placed machine as a learner at once *(reasoned: the model reads the placements themselves, so the short time before a placed machine is a learner, and a voter taken out of another group's config, are not modelled)*.

Each set is needed *(checked)*. With the listed machines only (mistake d04), the home group grows to two voters before the third machine comes, its placement is then written again to name all three, the third crashes before it is a voter, and the group opens with two voters (`NoShrinkOpen` on `fd-crash`, 11 steps). With the placed machines only (d05), a group opens with one voter while a second machine is listed and holds no copy yet (`OpenFull` on `fd-twobox`, 6 steps). With the listed machines and only the group's own placement (d10), the founder's machine, placed in the home group, crashes, and the second group places the two machines left, grows to them and opens with two voters (`NoShrinkOpen` on `fd-crash`, 13 steps): the other groups' placements are needed too.

What the count leaves out: a machine that holds the id, is down, and that no placement names yet is not counted. On `fd-crash` a second machine takes up the id and then crashes, and the home group opens with one voter while two machines hold the id (7 states) *(checked by the second reader)*. No property here forbids it.

**Two new world steps**, not rules:

- `Late` names machines that open the resource only once every group has opened its share. They never found it.
- `MaxShrink` lets a voter that is down, and is not the leader, be taken out of its group's config while the group's placement still names it. That is a group that shrinks below `Copies` on a resource with enough machines. Before this, Found.tla could not express a shrink: groups only grew.

**New properties.** `AllVoters` cannot hold in the decided form, since a group opens with the machines that are there. The `fd-` bounds check these in its place:

| Name | What it says |
|---|---|
| `OpenFull` | no group opens with fewer voters than `Copies`, or than the machines that are up and hold the resource when they are fewer |
| `NoShrinkOpen` | once some stored placement has named `Copies` machines, no group opens with fewer than `Copies` voters, even with a machine down or a group shrunk |
| `SpreadAll` | `Spread`, judged only when every machine was there at each placement and group record |
| `NotDoneAll` | a reach goal: founding is done with every machine there, a late one too |

In the decided form `Done` also asks that each group's placement names `Copies` machines, or every machine there when fewer, and that all of them are voters.

**Symmetry.** No rule names a machine, so the decided bounds with four or five machines name them as model values and use TLC's `SYMMETRY`: TLC keeps one state for all the ways of naming the machines. Their counts are not comparable with the `f-` bounds. Without symmetry `fd-four` was stopped at 1,638,945 states at depth 19 after 7 minutes, not counted *(measured)*; with it, it ends at 158,283. The other `fd-` bounds name the machines as strings, as the `f-` bounds do.

### What ran in the decided form

Each `f-` bound but two has a decided form: way B (`FirstVoter = "quiet"`) and `Fewer = "every"`. Each run is a line in [results/runs.txt](results/runs.txt) *(measured: 2 TLC workers on the shared 4-core box, beside another job and beside one other run of this folder)*.

| Bound | Decided form of | The world | Result | States | Depth | Seconds |
|---|---|---|---|---|---|---|
| `fd-onebox` | `f-onebox` | 1 machine, 2 groups, 2 slots | holds | 18 | 10 | 1 |
| `fd-twobox` | | 2 machines, 2 groups, 2 slots, 1 crash | holds | 1,504 | 17 | 3 |
| `fd-late` | | 3 machines, the third comes once every group has opened; 2 groups, 2 slots | holds | 1,168 | 19 | 4 |
| `fd-late-crash` | | as `fd-late`, 1 crash | holds | 7,304 | 22 | 6 |
| `fd-small` | `f-small` | 3 machines, 2 groups, 2 slots, no crash (with `SpreadAll`, `Even`) | holds | 5,984 | 18 | 6 |
| `fd-crash` | `f-crash`, `f-quiet-crash` | 3 machines, 2 groups, 2 slots, 1 crash | holds | 39,010 | 20 | 9 |
| `fd-crash2` | `f-crash2` | as `fd-crash`, 2 crashes | holds | 109,230 | 22 | 15 |
| `fd-homefirst` | `f-homefirst` | as `fd-crash`, the home group opens its share in the first entry | holds | 26,065 | 19 | 10 |
| `fd-shrink` | | as `fd-crash`, and a voter that is down may be taken out of its group once | holds | 57,154 | 22 | 14 |
| `fd-four` | `f-four`, `f-quiet` | 4 machines, 3 groups, 3 slots, no crash (with `SpreadAll`); symmetry | holds | 158,283 | 26 | 111 |
| `fd-reach` | `f-reach` | reach: founding done with every machine there, a crash allowed | goal reached | 27,920 | 16 | 11 |
| `fd-reach-late` | | reach: founding done after the late machine came | goal reached | 887 | 16 | 3 |
| `fd-reach-shrink` | | reach: a group shrank below `Copies` before it opened | goal reached | 2,178 | 10 | 3 |
| `fd-reach-spread` | `f-reach-spread` | reach: 3 machines, 3 groups, done, each led from another machine | goal reached | 177,999 | 22 | 57 |
| `fd-quiet-load` | `f-quiet-load` | reach: 5 machines, 3 groups, done with no machine in every group; symmetry | goal reached | 90,568 | 20 | 133 |
| `fd-live` | `f-live` | always can finish: 3 machines, 2 groups, 2 slots, 1 crash | can finish from all 26,441 judged states | 61,985 | 20 | 27 |
| `fd-late-live` | | always can finish: as `fd-late-crash` | can finish from all 4,849 judged states | 11,358 | 22 | 11 |
| `fd-two-live` | | always can finish: as `fd-twobox` | can finish from all 1,127 judged states | 2,185 | 17 | 5 |
| `fd-two-three` | | probe: as `fd-twobox` with no crash, growth as the ledger writes it (`Fewer = "three"`) | `NoStuck` fails, a run of 7 states | 50 | 7 | 2 |
| `fd-spread` | `f-aswritten`'s property | probe: `Spread` on `fd-small`'s world | `Spread` fails, a run of 10 states | 1,155 | 10 | 4 |
| **`fd-big`** | `f-big` | 4 machines, 3 groups, 3 slots, 1 crash; symmetry | holds | 1,755,093 | 30 | 962 |
| **`fd-many`** | `f-many` | 4 machines, 4 groups, 4 slots, no crash (with `SpreadEven`); symmetry | did not finish in the hour; no failure up to there | 5,760,495 when stopped, 1,252,508 on the queue | 24 | 3,600 |
| **`fd-many1`** | `f-many` | as `fd-many`, with 1 slot | holds | 993,438 | 28 | 732 |
| **`f-quiet-many`** | `f-many` | way B with the old reading of `slot-move.22`, no symmetry; alone on the box, 3 workers (below) | holds | 6,328,888 | 29 | 2,495 |

`f-aswritten` and `f-load` have no decided form: they are about the ledger before V5-38 and about way A. `f-quiet-crash` is the same world as `fd-crash`.

### What it shows

1. **One machine and two machines now found the resource and open every slot** *(checked: `fd-onebox`, `fd-twobox`; on two machines it can always finish, `fd-two-live`)*.
2. **A third machine that comes later is taken in.** The groups open with two voters, and when the third machine comes each group writes its placement again and grows to three *(checked: `fd-late`, `fd-late-crash`; the goal is reached, `fd-reach-late`; it can always finish, `fd-late-live`)*.
3. **A group that shrinks below `Copies` does not open on a resource with enough machines** *(checked: `fd-shrink`, `NoShrinkOpen`)*. The machine taken out is still in the group's placement, so the count stays at three. Read as the listed machines only, the shrunk group opens with two voters *(checked: d04 planted, on `fd-shrink`, with TLC told to go on past the first failure, which is the crash run above; the shortest run through a shrink has 11 states: the home group grows to three voters, one crashes and is taken out of the config, and the group opens with two)*.
4. **The growth rules must change with it.** With growth as the ledger writes it, a group on two machines keeps one voter: `growth.1` places three machines or none, and `growth.2` never rests a group at two voters. The decided count asks for two, so no slot opens (probe `fd-two-three`: `NoStuck` fails, a run of 7 states) *(checked)*. The model therefore places every listed machine while fewer than `Copies` are listed (d07 shows it is needed) and grows a group again when a machine comes (d08). `growth.3` (a group at two voters with fewer than three live candidates makes one a learner again) would undo the two voters on two machines; it is not modelled *(reasoned)*.
5. **Way B's group record must not wait for `Copies` machines.** This README said way B's record "waits until copies machines are there". With fewer machines that wait never ends: on one machine no other group is ever made (d06: `NoStuck` on `fd-onebox`). The decided form's record waits until `Copies` machines are listed, or the resource's machines when it has fewer. No property needs that shorter wait: mistake d13, which drops it, is caught on no `fd-` bound *(checked by the second reader)*. So the ledger holds no wait. The cost: if the other machines open the resource a moment after founding, a record may already have named the founder's machine, and it stays the group's preferred member (`handback.5`). On `fd-spread` the founder's machine is the preferred member of both groups (`Spread` fails, a run of 10 states) *(checked)*. That is the outcome of `f-aswritten` that V5-38 was chosen to avoid, in the case where the records are written before the other machines are listed. When every machine is there before the records, the leaders are spread (`SpreadAll` holds on `fd-small` and `fd-four`; `fd-reach-spread` reaches a founding where each group is led from another machine) *(checked)*. Spreading leaders after a late machine comes is left to the move policy, as for copies (see "Also seen, smaller" above).
6. **In a founding race, a slot opens and takes writes with one copy.** On `fd-small`'s world (3 machines, no crash) the founder opens the home group's share right after founding, before the other two have taken up the id (5 states), and a write then commits with one copy (6 states) *(checked by the second reader)*. No property here forbids it. Under the old reading it could not happen. It follows from counting only the machines a leader can see: at that moment the resource has one machine.

### Way B with four groups (V5-38)

V5-38 owed way B with four groups or more. The bound `f-quiet-many` is `f-many`'s world (4 machines, 4 groups, 4 slots, no crash, every machine there from the start) with way B, read as before card 0002 (`Fewer = "no"`), with every property of `f-many`, `SpreadEven` the one it is for. It ran alone on the box: 3 TLC workers, a 6 GB heap and 2 GB for TLC's fingerprints outside the heap, a checkpoint every 10 minutes, a limit of one hour.

**It finished, and every property holds, `SpreadEven` too: 6,328,888 states, depth 29, 2,495 s** *(checked; measured)*. TLC put the chance that two states shared a fingerprint at about 1 in 200,000 *(measured: 5.3E-6 optimistic, 1.5E-6 from the fingerprints)*. So with more groups than copies, way B spreads the preferred members as evenly as they can be, where way A does not (`f-many`, finding 11). The run on the second pass that ran out of memory had reached 2,195,739 states.

`f-quiet-many` reads `slot-move.22` as before card 0002. That gives the same verdict for `SpreadEven` as the decided reading *(reasoned)*: `SpreadEven` is judged only when every machine was there at each placement and group record, and on such a run every placement names three machines and every record's wait is met under both readings, so the same placements and records can be written. The decided form of the same world, `fd-many` (with symmetry), did not finish within its hour: it was stopped at 5,760,495 states at depth 24, with 1,252,508 still on the queue, and no property had failed *(measured; not counted)*. With one slot in place of four (`fd-many1`), it finishes and every property holds, `SpreadEven` too: 993,438 states with symmetry, depth 28, 732 s *(checked)*. `SpreadEven` does not look at slots, and the slots only add the opens and writes.

### The marks

The `new:` marks now name the records the owner added or changed *(counted)*. In `mutants.txt`, `results/mutants.json` and `results/mutants.md` the 87 mistakes changed in the rule column only; no mistake id and no result changed. The rows d01 to d10 are new (below).

| Was | Now | Lines |
|---|---|---|
| `new:ask-ended` | `subscribe.40` | Selection.tla, c25 |
| `new:picture-names-moved` | `subscribe.39` | Selection.tla, c10 |
| `new:turn-on-moved` | `subscribe.39` | Selection.tla, c11 |
| `new:picture-per-slot` | `subscribe.38` | Selection.tla, c02, c20 |
| `new:ready-per-slot` | `selection.1` | Selection.tla, c12 |
| `new:first-voter-by-load` | `growth.5` (way B's naming rule) | Found.tla, f20 |
| `new:settings-behind` | `line:settings-behind` | Settings.tla, s09, s10 |

`AsMade` and the line `line:settings-behind` are the property the owner dropped (V5-37). They stay in Settings.tla so that its runs stay as they were. The mark `growth.5 record` is on way A's line (the first voter is the home group's leader), the reading of `growth.5` before V5-38.

The small bounds were run again after the renames: every bound that holds has the same state count as before *(checked: the 25 small bounds that hold or can always finish have the same generated and distinct counts as on the second pass; see [results/runs.txt](results/runs.txt))*.

### Planted mistakes in the decided form

Ten more mistakes, ids d01 to d10, on the new lines. `mutate.py` runs them on the `fd-` bounds. They are counted apart from the 87 above, whose results stand.

| id | rule | the mistake | caught by |
|---|---|---|---|
| d01 | `slot-move.22 fewer` | the machines half dropped: a group needs Copies voters however few machines the resource has | NoStuck on fd-onebox, 6 steps |
| d02 | `slot-move.22 fewer` | the copies half dropped: a group needs a voter on every machine the resource has | NoStuck on fd-four, 17 steps |
| d03 | `slot-move.22 fewer` | the guard dropped: a group opens with any number of voters | OpenFull on fd-twobox, 6 steps |
| d04 | `slot-move.22 machines` | the resource's machines are only the listed ones: a machine that is down is not counted | NoShrinkOpen on fd-crash, 11 steps |
| d05 | `slot-move.22 machines` | the resource's machines are only the placed ones: a listed machine with no copy yet is not counted | OpenFull on fd-twobox, 6 steps |
| d06 | `line:record-waits` | way B's group record still waits for Copies machines | NoStuck on fd-onebox, 6 steps |
| d07 | `growth.1 fewer` | growth as written: a placement names Copies machines, never fewer | NoStuck on fd-twobox, 7 steps |
| d08 | `growth.2 fewer` | a group grows only from one voter, not again when a machine comes later | NoStuck on fd-small, 14 steps |
| d09 | `line:place-keeps-voters` | a placement written again may leave a voter out | **not caught** |
| d10 | `slot-move.22 machines` | the resource's machines are the listed ones and the group's own placement only, not the other groups' | NoShrinkOpen on fd-crash, 13 steps |

**9 of 10 caught** *(checked; [results/mutants.md](results/mutants.md) has the runs)*. d09 is not caught: when a group's placement is written again, no property here looks at a voter left out of it. It is like f28: the line is in the model and no property sees it.

### The ledger text for `slot-move.22`

Proposed, as the decided form runs it:

> No slot opens in a group that has fewer voters than the resource's copies setting, or than the resource's machines when it has fewer; voters are counted in the newest membership in the leader's log, committed or not, and the machines are every machine the leader may place a copy on and every machine that any group's stored placement names, up or down.

Each part is needed *(checked)*:

| Part | Planted out | What fails |
|---|---|---|
| "the resource's copies setting" | d02: a voter on every machine | `NoStuck` on `fd-four`: with four machines no group gets four voters |
| the guard itself | d03: no guard | `OpenFull` on `fd-twobox`: a group opens with one voter while two machines are there |
| "or than the resource's machines when it has fewer" | d01: `Copies` always | `NoStuck` on `fd-onebox`: one machine never opens a slot (the old text; probe `f-onebox`) |
| "every machine the leader may place a copy on" | d05: placed machines only | `OpenFull` on `fd-twobox`: a listed machine with no copy yet is not counted |
| "every machine that any group's stored placement names, up or down" | d04: listed machines only | `NoShrinkOpen` on `fd-crash` (a crash) and on `fd-shrink` (a shrink) |
| "any group's" | d10: the group's own placement only | `NoShrinkOpen` on `fd-crash`: a machine placed in another group is down |
| "the newest membership in the leader's log, committed or not" | n09 in the slot-move models | not in this model: a group's config here changes in one step |

The old reading's mistakes f08 and f09 stand for the copies half on a resource with enough machines.

Two other records must say something too, or the decided form is stuck on two machines (finding 4 of this section): `growth.1`, a placement of three machines or of every listed machine when fewer are listed, and written again as machines come; `growth.2` and `growth.3`, a group on fewer than three machines has a voter on each. Way B's record must not wait for `Copies` machines (d06), and no property needs a shorter wait (d13), so no record holds a wait. The ledger takes the text above and the growth changes as V5-39.

## Ledger changes proposed

**After card 0002: the owner took every recommended option (V5-33 to V5-39). V5-37 dropped the settings-version property, so `meta-catalog.6` below was not added.** The ledger now holds the other texts. What follows is the proposal as it stood before the answers. The text this folder now proposes for `slot-move.22` (V5-39) is in "After card 0002".

None is applied here. Each line: the record, the text now, the text proposed, why, the evidence.

**Text changes, each needed by a property** *(checked by the mistakes named)*:

| Record | Now | Proposed | Why and evidence |
|---|---|---|---|
| `meta-catalog.5` | Each group records the entry at which it took up a settings version, and an alter is in force, and answered, only once every group of the resource has taken it up. | Each group takes up a settings version only once the home log has committed it, by an entry in its own log, and an alter is in force, and answered, only once that entry has committed in every group of the resource. | Finding 1. s01 (`Same`), s02 (`InForce`); s03, s05 show the wait for every group is needed. Known: `reasoned` becomes `model`. |
| `route-smart.1` | A linked client sends each write to the cached leader of the write's slot; on moved it takes the new owner from the answer and resends the same attempt. | A linked client sends each write to the cached leader of the write's slot; on moved it takes the new owner from the answer, only if that row is newer than the one it holds, and resends the same attempt. | Finding 4. h03 (`Forward`); h09, h10 (`NoRepeat`) show the owner in the answer is needed. |
| `genesis-conditional-create.4` | The founder makes the home group with itself as the only voter; the first entry holds the id, the settings record, the seed and a first placement that names the founder alone. | The founder makes the home group with itself as the only voter; the first entry holds the id, the settings record, the seed, the slot table for every group and a first placement that names the founder alone, and it applies no seed row. | Finding 7 (a), (b). f11 (`OnceSlot`), f12 (`SeedOnce`). |
| `genesis-conditional-create.8` | At founding, the home group's leader makes the resource's other groups from the size hint and gives each its slots before the first write. | At founding, each group the size hint asks for opens only its own share of the first entry's slot table, by an entry in its own log that also applies the seed rows of those slots, before its first write. | Finding 7 (a), (b). f10 (`OnceSlot`). Known: `reasoned` becomes `model`. |
| `growth.5` | A new group of a growing resource is made by a group record in the home log, with the creating leader's process as its first voter, and grows by these same rules. | A new group is made by a group record in the home log that names its first voter; only the machine named makes the group, once, and the group grows by these same rules. | Finding 7 (c). f06 (`OneLog`), f07 (`OneLog`). Who is named is the choice below. The record is in slice 3; founding with a pre-split (slice 2) needs it. Known: `reasoned` becomes `model`. |
| `selection.1` | A selection over a whole resource is one subscription per group, and it is ready only when every group's picture has come. | A selection over a whole resource is one subscription per group, and it is ready only when every group's picture has come and a picture covers every slot. | Finding 8. `c-asread` and c12 (`Whole`). Known: `reasoned` becomes `model`. |

**New records** (the ids are the next free ones; each adds to the rule count, so each goes through the owner's gate):

| Record | Proposed text | Why and evidence |
|---|---|---|
| `subscribe.38` | A subscriber takes a picture's part for a slot only if its position is at or past the subscriber's cursor for that slot. | Finding 9 (a). c02 (`NoBack`). |
| `subscribe.39` | A group's picture names each slot the group has handed off and the group it went to, and the subscriber asks that group for the slot unless it already takes the slot from there. | Finding 9 (b), (c). c10, c11 (`NoStuck`). |
| `subscribe.40` | A group asked for a slot it has handed off answers END at once and names the group the slot went to; a subscriber that gets END from the group it asked turns to the group named. | Finding 10. c25 (`NoStuck`), c26 (cannot always finish). |
| `meta-catalog.6` | A write names the settings version its sender holds, and a group whose log has not taken that version up sends the write back to be sent again. | Finding 2. s09 (`AsMade`). Only if the property is wanted: it also adds a field to a write. |

**A choice for the owner: how a new group's leader lands on another machine** (finding 5). As written, `growth.5`, `handback.5` and `handback.6` together break `move-policy.6` (`f-aswritten`). Two ways out, both checked (way A on the `f-` bounds, way B on the `f-quiet` bounds):

| Way | Changes | What it gives |
|---|---|---|
| A, an exception | `handback.5`: "... picked again only once it has left the group's stored placement, or when a new group writes its first full placement ...". `move-policy.6`: "A new group's first full placement is picked by load and memory, and names as preferred member the placed machine that should lead the fewest groups." | `growth.5` keeps the creating leader as first voter. That machine holds a copy of every group it makes (`f-load`). |
| B, name another machine | `growth.5`: "... a group record in the home log that names as first voter the machine named for the fewest groups ...". `move-policy.6`: "A new group's placement is picked by load and memory, and its first voter is not the creating leader's machine when another can be." | `handback.5` and `handback.6` stay as written. No machine has to hold every group (`f-quiet-load`). The record waits until `copies` machines are there; with fewer machines, until the resource's machines are (see "After card 0002"). |

**Notes on the proposals above, from the second pass:**

- `growth.5`: the proposed text should also say the record is written once and its first voter never changes (f21).
- `route-smart.1`: "only if newer" holds for every row a client takes, on a new link too (h12, h13). `slot-table.6` may be the better home: "the slot table, every copy and every client keep the highest version of each slot's row".
- `genesis-conditional-create.4`: "it applies no seed row" is more than the runs show. `f-homefirst` holds with the home group applying the seed rows of its own share in the first entry. What f12 shows is: the first entry applies no seed row of another group's slots.
- The choice for finding 5: way A as proposed is shown only for as many groups as copies (finding 11). If way A is taken, the placement must also look at who leads what, or the preferred member must be picked before the placement. Way B was not shown either way past 3 groups then; after card 0002 it holds with 4 groups on 4 machines (`f-quiet-many`).

**Evidence only** (the text stands): `meta-catalog.4` holds with two groups, beside `writer-judging.1` and `writer-judging.2` (s06, s07, s08, s12); `home-records.1` and `home-records.2` hold and are needed (h06, h07; the model keeps only the slot table's row, so "partial model"); `selection.6` holds for a live selection's ready (c13); `subscribe.29` holds for a whole selection (c07, c08, c09); `slot-table.1` holds in both worlds (h01, f13).

**A question, no proposal: `slot-move.22` on one machine** (finding 6). The decision behind it (V5-18 pick 7) is about a new group of a growing resource. The record's text covers every group, the founding ones too, and on one machine it never lets a slot open. Either the text says which groups it is for, or it says what "its voters" means when the machines are fewer than `copies`.


## How to rerun

```sh
export TLA_JAR=<the tools jar>      # tla2tools.jar
export WORK=<scratch dir>           # TLC's files go here
./run.sh                            # the small bounds, the reach checks, the probes, the fd- bounds: ends "ok founding"
./run.sh big                        # also the big bounds, each under one hour
./run.sh big s-big                  # one bound by name
./run.sh mutants                    # every planted mistake; writes results/mutants.md
./run.sh mutants s03 c12            # some of them
```

`HEAVY` may name a wrapper command (a CPU lock on a shared box). `WORKERS` is TLC's worker threads (default 2). `JAVA_MEM` is the JVM's memory flags (default `-Xmx4g`) and `FPMEM` TLC's `-fpmem`. TLC keeps its fingerprints outside the heap, by default a quarter of the box's memory, so on a shared box set both: `f-quiet-many` ("After card 0002") ran with `JAVA_MEM="-Xmx6g -XX:MaxDirectMemorySize=2g" FPMEM=0.11`. `LIMIT` is the seconds one run may take (default 3600); when it passes, the run's whole process group is killed and the run is not counted.

**Pause and resume.** A big bound runs with `-checkpoint 10`: TLC saves its state every 10 minutes under `$WORK/<bound>/meta` (`EVERY` sets the minutes). If the run is stopped (the box restarts, the limit passes, Ctrl-C), go on from the last checkpoint with:

```sh
./run.sh resume s-big
```

That passes TLC `-recover` with the newest checkpoint folder. Keep `$WORK`: the checkpoint lives there. A resumed run must hash states the same way as the run it goes on from, and TLC picks its hash function at random for each run, so `run.sh` pins it (`-fp 1 -seed 1`) for the big bounds. This was tried *(checked)*: `c-big` was stopped after 79 s and resumed; it ended with the same 4,140,146 states and depth as the run that was never stopped ([results/resume.txt](results/resume.txt)). After a resume TLC's "generated" count starts again from the checkpoint; the distinct states and the result stand. A resumed run's time is the sum of its parts; count it only if the sum is under the hour.

The small bounds each take seconds to two minutes, so they are simply run again. A pass over the planted mistakes is 97 short jobs (87, then d01 to d10 on the `fd-` bounds): `mutate.py` takes ids, so a stopped pass goes on with the ids that are left, and it merges them into `results/mutants.json`.

## Files

| File | What |
|---|---|
| `Settings.tla`, `HomeRecords.tla`, `Found.tla`, `Selection.tla` | the four models |
| `*Live.tla` | each model with the tag for the "always can finish" check |
| `agef.py` | that check, on the graph TLC writes |
| `s-*.cfg`, `h-*.cfg`, `f-*.cfg`, `c-*.cfg` | one bound each, for rows 1 to 4 |
| `fd-*.cfg` | row 3 in the decided form, after card 0002 (way B, `Fewer = "every"`) |
| `mutants.txt`, `mutate.py` | the planted mistakes and their runner |
| `run.sh` | reruns everything |
| `results/runs.txt` | every counted run: bound, result, states, depth, seconds |
| `results/mutants.md`, `results/mutants.json` | every planted mistake and what caught it |
| `results/traces.txt` | the runs behind the findings, step by step |
| `results/resume.txt` | the stop and resume that was tried |
