# Planted mistakes

Made by `mutate.py` from `mutants.txt`. A mistake is caught when a property fails on a bound, when a reach goal can no longer be reached, or when the "always can finish" check fails.

**79 of 87 caught (90 %).**

## Settings (row 1): 14 of 15 caught

| id | rule | the mistake | caught by | runs |
|---|---|---|---|---|
| s01 | `meta-catalog.5 home-committed` | a group takes up a home entry that has not committed | Same on s-small, 5 steps | 1, 1 s |
| s02 | `meta-catalog.5` | the alter is answered on a take-up that has not committed | InForce on s-small, 6 steps | 1, 1 s |
| s03 | `meta-catalog.5` | the alter is answered once one group took it up | InForce on s-two, 7 steps | 2, 4 s |
| s04 | `meta-catalog.5` | flip >= to >: the alter waits for a version past its own | NoStuck on s-small, 8 steps | 1, 2 s |
| s05 | `meta-catalog.5` | the alter is answered without waiting for the other groups | InForce on s-small, 4 steps | 1, 2 s |
| s06 | `meta-catalog.4` | drop the read-only gate | GateGroup on s-small, 6 steps | 1, 2 s |
| s07 | `meta-catalog.4` | the gate is read from committed entries only, not the log end | GateGroup on s-small, 6 steps | 1, 2 s |
| s08 | `writer-judging.1` | a write is judged under the committed settings, not the ones at the log end | JudgeOrder on s-small, 6 steps | 1, 2 s |
| s09 | `line:settings-behind` | drop the refusal of a write made under settings the group has not taken up | AsMade on s-small, 7 steps | 1, 2 s |
| s10 | `line:settings-behind` | flip > to >=: a write made under the group's own settings is sent back | cannot always finish on s-live: 191 of 1102 judged states | 5, 27 s |
| s11 | `meta-catalog.5 own-entry` | the take-up entry drops the gate | Same on s-small, 5 steps | 1, 1 s |
| s12 | `writer-judging.2` | the read-only refusal is sent before the gate's entry has committed | RoTrue on s-small, 4 steps | 1, 1 s |
| s13 | `line:learn-committed` | a copy hands out a settings version its group has not committed | Shape on s-alter2, 5 steps | 3, 34 s |
| s14 | `line:ack-committed` | ok is told before the write commits | Told on s-small, 4 steps | 1, 2 s |
| s15 | `line:send-names-version` | a first send names no settings version | **not caught** | 6, 129 s |

## HomeRecords (row 2): 15 of 17 caught

| id | rule | the mistake | caught by | runs |
|---|---|---|---|---|
| h01 | `slot-table.1` | a leader takes a write for a slot its log does not hold open | Right on h-small, 5 steps | 1, 1 s |
| h02 | `soft-directory.8` | drop the resource check | TrueOk on h-foreign, 4 steps | 2, 3 s |
| h03 | `slot-table.6` | the client takes any row, older ones too | Forward on h-small, 9 steps | 1, 2 s |
| h04 | `route-forward.1` | a copy that cannot forward drops the write | NoStuck on h-small, 8 steps | 1, 2 s |
| h05 | `route-smart.2` | the client takes no answer as the end and never sends again | NoStuck on h-small, 7 steps | 1, 2 s |
| h06 | `home-records.2` | a follower keeps no home records: it knows only its own group's log | cannot always finish on h-live: 732 of 41135 judged states | 5, 27 s |
| h07 | `home-records.1` | a leader keeps no home records: it knows only its own group's log | cannot always finish on h-live: 732 of 56057 judged states | 5, 32 s |
| h08 | `home-records.2` | a follower hands out the home records only, never what its own log knows | **not caught** | 5, 33 s |
| h09 | `slot-table.3` | a "moved" answer names no owner | NoRepeat on h-small, 7 steps | 1, 2 s |
| h10 | `route-smart.1` | the client always writes to the home group | NoRepeat on h-small, 7 steps | 1, 2 s |
| h11 | `soft-directory.9` | the client never asks the directory again | cannot always finish on h-live: 2496 of 35965 judged states | 5, 39 s |
| h12 | `line:dial-newer` | on a new link the client takes the copy's row, older or not | NoRepeat on h-small, 10 steps | 1, 4 s |
| h13 | `line:moved-newer` | on moved the client takes the row in the answer, older or not | NoRepeat on h-small, 12 steps | 1, 3 s |
| h14 | `line:moved-own-log` | a leader answers moved from its copy of the home records only, not its own log | NoRepeat on h-pre, 7 steps | 3, 17 s |
| h15 | `route-forward.2 pass` | a forwarding copy never passes a moved answer on to the client | NoStuck on h-small, 8 steps | 1, 3 s |
| h16 | `line:higher` | a copy keeps the older of two rows | NoRepeat on h-pre, 7 steps | 3, 15 s |
| h17 | `route-smart.2` | no answer is not counted as a failure of the member | **not caught** | 5, 55 s |

## Found (row 3): 27 of 29 caught

| id | rule | the mistake | caught by | runs |
|---|---|---|---|---|
| f01 | `genesis-conditional-create.1` | the store's create succeeds over a stored id | OneId on f-small, 6 steps | 1, 2 s |
| f02 | `genesis-conditional-create.3` | an opener founds though the stored id is not its own | OneId on f-small, 5 steps | 1, 2 s |
| f03 | `genesis-conditional-create.2` | an opener makes a candidate though its dir holds an id | OneLog on f-small, 6 steps | 1, 2 s |
| f04 | `genesis-conditional-create.6` | an opener adopts though its dir holds an id | cannot always finish on f-live: 81 of 18263 judged states | 7, 644 s |
| f05 | `genesis-conditional-create.5` | an opener adopts an id that is not the stored one | OneId on f-small, 4 steps | 1, 1 s |
| f06 | `growth.5 first-voter` | any machine makes the group, not only the one the record names | OneLog on f-small, 8 steps | 1, 2 s |
| f07 | `growth.5 once` | a machine makes a group it already holds | OneLog on f-small, 7 steps | 1, 1 s |
| f08 | `slot-move.22` | a group opens its slots before it has its voters | AllVoters on f-small, 5 steps | 1, 1 s |
| f09 | `slot-move.22` | flip >= to > | NoStuck on f-small, 13 steps | 1, 2 s |
| f10 | `genesis-conditional-create.8 table` | a group opens every slot, not its share | OnceSlot on f-small, 9 steps | 1, 1 s |
| f11 | `genesis-conditional-create.8 share` | the first entry opens every slot in the home group | OnceSlot on f-small, 4 steps | 1, 1 s |
| f12 | `genesis-conditional-create.4 seed` | the first entry applies the whole seed in the home group | SeedOnce on f-small, 4 steps | 1, 1 s |
| f13 | `slot-table.1` | a group takes a write for a slot it does not hold open | SeedOnce on f-small, 5 steps | 1, 1 s |
| f14 | `handback.2` | leadership is handed to a machine that is not a voter | LeadVoter on f-small, 10 steps | 1, 1 s |
| f15 | `healing-self.19` | a placement ignores load | Even on f-four, 14 steps | 5, 48 s |
| f16 | `move-policy.6` | a new group's preferred member ignores load | Spread on f-small, 10 steps | 1, 2 s |
| f17 | `healing-self.16` | a placement names a machine the leader cannot reach | OneId on f-small, 6 steps | 1, 2 s |
| f18 | `genesis-conditional-create.4` | the founder is not the home group's only voter | VoterHas on f-small, 4 steps | 1, 1 s |
| f19 | `handback.1` | leadership is never handed to the preferred member | cannot always finish on f-live: 2039 of 2213 judged states | 7, 60 s |
| f20 | `growth.5` | a group record names any machine, whatever it was named for already | Spread on f-quiet, 10 steps | 4, 11 s |
| f21 | `line:record-once` | a group record is written again, by a later leader | OneLog on f-crash, 14 steps | 2, 7 s |
| f22 | `line:place-leader` | a placement leaves the group's leader out | PrefPlaced on f-small, 7 steps | 1, 2 s |
| f23 | `line:open-once` | a group opens its share again | SeedOnce on f-small, 10 steps | 1, 2 s |
| f24 | `line:adopt-stored` | an opener adopts when nothing is stored | OneId on f-small, 4 steps | 1, 2 s |
| f25 | `growth.5 record` | a group record names any machine as first voter | Even on f-four, 14 steps | 5, 149 s |
| f26 | `handback.5` | the preferred member is picked again though it has not left the placement | Spread on f-small, 10 steps | 1, 3 s |
| f27 | `growth.1` | a full placement is written again | Even on f-four, 15 steps | 5, 939 s |
| f28 | `growth.2` | a group grows to machines that do not answer | **not caught** | 7, 159 s |
| f29 | `line:handback-up` | leadership is handed to a preferred member that is down | **not caught** | 7, 147 s |

## Selection (row 4): 23 of 26 caught

| id | rule | the mistake | caught by | runs |
|---|---|---|---|---|
| c01 | `subscribe.14` | the client takes a record that is not the next one | Exact on c-small, 12 steps | 1, 3 s |
| c02 | `subscribe.38` | the client takes a picture of a slot from before its cursor | NoBack on c-small, 10 steps | 1, 3 s |
| c03 | `subscribe.13` | a picture does not set the slot's cursor | Exact on c-small, 5 steps | 1, 3 s |
| c04 | `subscribe.12` | a picture does not put in the slot's rows | Exact on c-small, 5 steps | 1, 2 s |
| c05 | `subscribe.16` | a record does not move the cursor on | Exact on c-small, 7 steps | 1, 3 s |
| c06 | `subscribe.15` | a record taken is not applied | Exact on c-small, 7 steps | 1, 3 s |
| c07 | `subscribe.29 end` | END names the old group, not the new one | **not caught** | 7, 102 s |
| c08 | `subscribe.29 turn` | the client ignores END | NoStuck on c-small, 12 steps | 1, 3 s |
| c09 | `subscribe.29 again` | the client never asks the new group for the slot | cannot always finish on c-live: 1177 of 7770 judged states | 6, 44 s |
| c10 | `subscribe.39` | a picture does not name the slots the group handed off | NoStuck on c-small, 9 steps | 1, 3 s |
| c11 | `subscribe.39` | a slot the client never held is not asked for at the new group | NoStuck on c-small, 9 steps | 1, 3 s |
| c12 | `selection.1` | ready as soon as every group's picture has come | Whole on c-small, 8 steps | 1, 3 s |
| c13 | `selection.1 ready` | ready once one group's picture has come | Waits on c-down, 7 steps | 3, 15 s |
| c14 | `subscribe.3` | a picture names the wrong position | NoStuck on c-small, 8 steps | 1, 3 s |
| c15 | `subscribe.5` | a server sends a record that has not committed | Exact on c-small, 6 steps | 1, 2 s |
| c16 | `slot-move.9` | a group answers for a slot another group holds | **not caught** | 7, 55 s |
| c17 | `subscribe.1` | a group streams slots it does not hold | NoStuck on c-small, 11 steps | 1, 2 s |
| c18 | `subscribe.6` | a record is sent under the next position | NoStuck on c-small, 10 steps | 1, 2 s |
| c19 | `line:spic-src` | a slot's picture does not set the group the slot is taken from | NoStuck on c-back, 17 steps | 4, 17 s |
| c20 | `subscribe.38` | a picture that does not cover a slot is taken for it | Exact on c-small, 4 steps | 1, 2 s |
| c21 | `line:spic-position` | a slot's picture names position 0 | NoStuck on c-small, 13 steps | 1, 2 s |
| c22 | `line:spic-sent` | after a slot's picture the group skips a record | NoStuck on c-small, 13 steps | 1, 2 s |
| c23 | `line:end-src` | an END from a group the slot is not taken from clears where it is taken from | NoStuck on c-back, 16 steps | 4, 19 s |
| c24 | `subscribe.29 turn` | an END from any group turns the client, an old END too | **not caught** | 7, 55 s |
| c25 | `subscribe.40` | an ask for a slot the group handed off waits for ever | NoStuck on c-back, 12 steps | 4, 24 s |
| c26 | `subscribe.29 turn` | an END that answers an ask does not turn the client | cannot always finish on c-back-live: 1484 of 37757 judged states | 7, 58 s |

## Found in the decided form, after card 0002: 9 of 10 caught

Way B and the new reading of `slot-move.22` (Fewer = "every"), on the fd- bounds. Counted apart from the total above.

| id | rule | the mistake | caught by | runs |
|---|---|---|---|---|
| d01 | `slot-move.22 fewer` | the machines half dropped: a group needs Copies voters however few machines the resource has | NoStuck on fd-onebox, 6 steps | 1, 1 s |
| d02 | `slot-move.22 fewer` | the copies half dropped: a group needs a voter on every machine the resource has | NoStuck on fd-four, 17 steps | 7, 60 s |
| d03 | `slot-move.22 fewer` | the guard dropped: a group opens with any number of voters | OpenFull on fd-twobox, 6 steps | 2, 4 s |
| d04 | `slot-move.22 machines` | the resource's machines are only the listed ones: a machine that is down is not counted | NoShrinkOpen on fd-crash, 11 steps | 4, 16 s |
| d05 | `slot-move.22 machines` | the resource's machines are only the placed ones: a listed machine with no copy yet is not counted | OpenFull on fd-twobox, 6 steps | 2, 4 s |
| d06 | `line:record-waits` | way B's group record still waits for Copies machines | NoStuck on fd-onebox, 6 steps | 1, 2 s |
| d07 | `growth.1 fewer` | growth as written: a placement names Copies machines, never fewer | NoStuck on fd-twobox, 7 steps | 2, 4 s |
| d08 | `growth.2 fewer` | a group grows only from one voter, not again when a machine comes later | NoStuck on fd-small, 14 steps | 3, 11 s |
| d09 | `line:place-keeps-voters` | a placement written again may leave a voter out | **not caught** | 11, 257 s |
| d10 | `slot-move.22 machines` | the resource's machines are the listed ones and the group's own placement only, not the other groups' | NoShrinkOpen on fd-crash, 13 steps | 4, 20 s |

## Probes: 3 of 3 not caught, as expected

Changes the design says are harmless in these worlds. They should NOT be caught.

| id | rule | the mistake | caught by | runs |
|---|---|---|---|---|
| x01 | `subscribe.29 at-fence` | END goes out before the last records below the fence (a picture replaces them in state mode) | not caught | 7, 61 s |
| x02 | `subscribe.14` | the client takes a record past the next one (no stream here has a gap) | not caught | 7, 57 s |
| x03 | `slot-table.6` | flip > to >=: a row of the same epoch is the same row | not caught | 5, 17 s |
