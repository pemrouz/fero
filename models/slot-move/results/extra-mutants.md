# More planted mistakes

Made by `extra.py` from `extra-mutants.txt`: mistakes on lines that `mutants.txt` does not list. A probe is a change expected to be harmless.

| id | model | the mistake | caught by | runs |
|---|---|---|---|---|
| e01 | SlotMove | a leader reads the stream table and the sequence from its committed log, not its log end | PosUnique on core, 5 steps | 1, 2 s |
| e02 | SlotMove | the voters are counted in the committed log, not at the log end (Finding 9, first model) | OpenFull on ver, 9 steps | 6, 23 s |
| e04 | SlotMove | "the last move has ended" is read from the committed table, not the leader's log end | TableRight on twice, 9 steps | 4, 12 s |
| e05 | SlotMove | the abort names the target as the move's source | TableRight on core, 7 steps | 1, 1 s |
| e06 | SlotMove | the row is written back to the target, not the source | TableRight on core, 7 steps | 1, 2 s |
| e07 | SlotMove | (world) a dropped tail comes back after a later commit | PosUnique on crash, 7 steps | 2, 4 s |
| e08 | SlotMove | a refused write moves the row's version | VerRight on ver2, 9 steps | 7, 34 s |
| e09 | SlotMove | the lock fence table forgets the tokens of the group's own writes | TokOrder on lock, 5 steps | 5, 20 s |
| e10 | SlotMove | the last stamp forgets the group's own writes | StampOrder on core, 11 steps | 1, 2 s |
| e11 | SlotMove | the kept answers forget the group's own writes | AnswersKept on core, 3 steps | 1, 2 s |
| e14 | SlotMove | probe: the target does not check that the fence names it | **not caught** | 14, 184 s |
| f01 | SlotMoveMsg | the final copy keeps the target's own epoch, not the source's | InOrder on msg-core, 10 steps | 1, 2 s |
| f02 | SlotMoveMsg | a leader reads the stream table and the sequence from its committed log | InOrder on msg-core, 5 steps | 1, 2 s |
| f03 | SlotMoveMsg | the row is written back to the target, not the source | TableRight on msg-core, 5 steps | 1, 2 s |
| f04 | SlotMoveMsg | a group reopens on another group's recovery row | StateRight on msg-rec2, 6 steps | 11, 112 s |
| f05 | SlotMoveMsg | a recovery's row takes no new number | **not caught** | 18, 191 s |
| f06 | SlotMoveMsg | the recovery's own entry is not committed, so a leader change can drop it | NoBack on msg-rec, 4 steps | 4, 5 s |
| f07 | SlotMoveMsg | a plain reopen makes up a new epoch the home log does not know | TableRight on msg-core, 9 steps | 1, 1 s |
| f08 | SlotMoveMsg | the target's final copy makes no report | the goal cannot be reached on msg-r-twice | 18, 153 s |
| f09 | SlotMoveMsg | the row written back takes its epoch from any move's row | PosUnique on msg-rec2, 24 steps | 11, 187 s |
| f11 | SlotMoveMsg | probe: the fence binds the target's incarnation of now, not the row's | TableRight on msg-rec, 10 steps | 4, 8 s |
| f12 | SlotMoveMsg | probe: the target does not check that the fence names it | OneTaker on msg-rec2, 8 steps | 11, 107 s |
| f13 | SlotMoveMsg | probe: the fence takes its base from another move's ready report | **not caught** | 18, 191 s |
| f14 | SlotMoveMsg | probe: the row is written back twice | **not caught** | 18, 1701 s |
| f15 | SlotMoveMsg | probe: a leader takes writes behind an open that has not committed (Finding 5's one-commit window, with a recovery) | **not caught** | 18, 202 s |
| g01 | SlotMoveMembers | a leader reads the stream table and the sequence from the log it knows committed | PosUnique on mem-src-core, 6 steps | 1, 2 s |
| g02 | SlotMoveMembers | a member takes the leader's whole log as committed | RaftSafe on mem-src-cfg2, 13 steps | 8, 43 s |
| g03 | SlotMoveMembers | a leader that votes for another goes on leading in the new term | the model stops with an error on mem-dst-fault | 5, 15 s |
| g04 | SlotMoveMembers | half of the voters count as a majority | the model stops with an error on mem-dst-grow | 3, 7 s |
| g05 | SlotMoveMembers | the final copy takes the records of a member's whole log, not the committed part before the fence | **not caught** | 11, 113 s |
