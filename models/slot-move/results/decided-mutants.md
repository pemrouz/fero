# Planted mistakes in the decided form

Made by `decided.py` from `decided-mutants.txt`, on the decided form's bounds (OneCommit = TRUE, BackFirst = FALSE). A mistake is caught when a property fails on a bound, when the model stops with an error, when a reach goal can no longer be reached, or when the stall check finds a state the writes cannot finish from. In the first model the safety bounds run first without `Whole`.

| record | id | model | the mistake | caught by | runs |
|---|---|---|---|---|---|
| `slot-table.8` | u04 | SlotMoveMsg | a move's row does not hold the target's incarnation | the goal cannot be reached on msg-d-r-afterdst | 14, 70 s |
| `slot-table.8` | u06 | SlotMoveMsg | a recovered target takes a final copy ordered for its old life | OneTaker on msg-d-rec, 9 steps | 4, 13 s |
| `slot-table.8` | f11 | SlotMoveMsg | the fence binds the target's incarnation of now, not the row's (a probe of the second reading) | OneTaker on msg-d-rec, 9 steps | 4, 12 s |
| `slot-table.8` | f12 | SlotMoveMsg | the target does not check that the fence names it (a probe of the second reading) | OneTaker on msg-d-rec2, 8 steps | 17, 152 s |
| `slot-table.9` | u01 | SlotMoveMsg | a recovered group goes on serving the slot from its cut log | OneServer on msg-d-rec, 2 steps | 4, 11 s |
| `slot-table.9` | u22 | SlotMoveMsg | a group reopens on the recovery row of an older life | NoBack on msg-d-rec2, 10 steps | 17, 153 s |
| `slot-table.9` | u23 | SlotMoveMsg | a recovered group reopens in its old epoch | NoBack on msg-d-rec, 7 steps | 4, 7 s |
| `slot-table.9` | f04 | SlotMoveMsg | a group reopens on another group's recovery row | StateRight on msg-d-rec2, 6 steps | 17, 139 s |
| `slot-table.10` | u18 | SlotMoveMsg | a recovered group asks for a slot its copy does not hold | **not caught** | 17, 239 s |
| `slot-table.10` | u19 | SlotMoveMsg | a recovered group gets a row for a slot the table gives to another group | TableRight on msg-d-rec, 8 steps | 4, 10 s |
| `slot-table.10` | u20 | SlotMoveMsg | a recovered group gets a row though its copy is older than the last move into it | TableRight on msg-d-rec-twice, 9 steps | 8, 35 s |
| `slot-table.11` | u09 | SlotMoveMsg | a recovered target does not say its old life's records may be lost | NoBack on msg-d-rec, 13 steps | 4, 12 s |
| `slot-table.11` | u10 | SlotMoveMsg | the row written back after a lost target is an ordinary one | NoBack on msg-d-rec, 14 steps | 4, 11 s |
| `slot-table.11` | u11 | SlotMoveMsg | a lost target's old move overrides a newer move into it | TableRight on msg-d-rec-three, 20 steps | 16, 87 s |
| `slot-table.11` | u12 | SlotMoveMsg | a lost target's old move overrides its own recovery row | **not caught** | 17, 224 s |
| `slot-table.11` | u13 | SlotMoveMsg | a move out of the lost target hides that the slot went back | NoBack on msg-d-rec-twice, 15 steps | 8, 43 s |
| `slot-table.11` | u14 | SlotMoveMsg | the row written back after a lost target is not above the later rows | TableRight on msg-d-rec-twice, 16 steps | 8, 47 s |
| `slot-table.11` | u15 | SlotMoveMsg | the row written back after a lost target keeps the old epoch | NoBack on msg-d-rec, 14 steps | 4, 14 s |
| `slot-table.11` | u16 | SlotMoveMsg | the source reopens in its old epoch after a lost target | NoBack on msg-d-rec, 14 steps | 4, 14 s |
| `slot-table.11` | u17 | SlotMoveMsg | the source reopens after a lost target before the row is written back | the model stops with an error on msg-d-rec | 4, 10 s |
| `slot-move.24` | m22 | SlotMove | the source fences one move a second time | the stall check on d-s-twice (home up: the writes can finish; home up: and the table names the server; home down: the writes can finish without it) | 14, 330 s |
| `slot-move.24` | u24 | SlotMoveMsg | the source fences a move older than one it already acted on | InOrder on msg-d-rec-twice, 24 steps | 8, 52 s |
| `slot-move.24` | u25 | SlotMoveMsg | a group that holds the slot open takes a final copy | NoBack on msg-d-rec-twice, 19 steps | 8, 43 s |
| `slot-move.24` | u26 | SlotMoveMsg | a group takes the final copy of a move older than one it already acted on | OneTaker on msg-d-rec-three, 20 steps | 16, 85 s |
| `slot-move.24` | n05 | SlotMoveMembers | a leader fences the move a second time | **not caught** | 10, 196 s |
| `slot-move.24` | d05 | SlotMove | probe: the record as written bars only a move older than the newest its log names, so the source may fence the newest move again (twice at most here) | **not caught** | 23, 508 s |
| `slot-move.24` | d06 | SlotMoveMsg | probe: the record as written, for the fence: the newest move its log names may be fenced again (twice at most here) | NoBack on msg-d-rec-twice, 21 steps | 8, 65 s |
| `slot-move.24` | d07 | SlotMoveMsg | probe: the record as written, for the final copy: a final copy for the newest move its log names is not barred by this line | **not caught** | 17, 265 s |
| `slot-move.24` | d08 | SlotMove | slot-move.8 replaced by the first half of slot-move.24 alone: the target takes a final copy unless its log names a newer move | Views on d-core, 11 steps | 1, 3 s |
| `slot-move.23` | m21 | SlotMove | a target that gave up answers retry, not moved | the stall check on d-s-lazy (home down: the writes can finish without it) | 13, 176 s |
| `move-policy.7` | t06 | SlotMove | a move counts as ended once its abort commits, row or no row | TableRight on d-twice, 11 steps | 4, 27 s |
| `move-policy.7` | t07 | SlotMove | a move counts as ended on a final copy that has not committed | TableRight on d-twice, 17 steps | 4, 28 s |
| `move-policy.7` | u53 | SlotMoveMsg | a move counts as ended with no final copy | TableRight on msg-d-rec-twice, 6 steps | 8, 44 s |
| `move-policy.7` | d04 | SlotMoveMsg | a move counts as ended once its abort is reported, row or no row (t06 in the second model) | TableRight on msg-d-rec-twice, 8 steps | 8, 48 s |
| `slot-table.5` | d01 | SlotMove | the source's reopen waits for the row (slot-table.5 as it was) | the stall check on d-s-lazy (home down: the writes can finish without it) | 13, 141 s |
| `slot-table.5` | d03 | SlotMoveMsg | the source's reopen waits for the row (slot-table.5 as it was), second model | **not caught** | 17, 249 s |
| `slot-table.5` | d02 | SlotMove | the row is never written back after a give-up | the stall check on d-s-lazy (home up: and the table names the server) | 13, 85 s |
| `slot-table.5` | t05 | SlotMove | the row is written back on an abort that has not committed | TableRight on d-crash, 11 steps | 2, 7 s |
| `slot-table.5` | e06 | SlotMove | the row is written back to the target, not the source | TableRight on d-core, 7 steps | 1, 2 s |
| `slot-table.5` | f03 | SlotMoveMsg | the row is written back to the target, not the source | TableRight on msg-d-core, 5 steps | 1, 2 s |
| `slot-move.19` | m16 | SlotMove | the source reopens on an abort that has not committed | OneTaker on d-crash, 9 steps | 2, 6 s |
| `slot-move.19` | m17 | SlotMove | the source reopens with no abort | OneTaker on d-core, 7 steps | 1, 2 s |
| `slot-table.1` | m03 | SlotMove | the source takes a write after its fence is in its log | PosUnique on d-core, 4 steps | 1, 2 s |
| `slot-table.1` | u45 | SlotMoveMsg | the source takes a write after its fence is in its log | NoLoss on msg-d-core, 3 steps | 1, 2 s |
| `slot-table.1` | n02 | SlotMoveMembers | a leader takes a write after the fence is in its own log | Views on mem-d-src-core, 4 steps | 1, 2 s |
| `slot-move.3` | m01 | SlotMove | the fence does not stop the source | OneTaker on d-core, 6 steps | 1, 2 s |
| `slot-move.3` | u44 | SlotMoveMsg | the fence does not stop the source | OneTaker on msg-d-core, 5 steps | 1, 2 s |
| `slot-move.3` | n01 | SlotMoveMembers | the fence does not stop the source | OneServer on mem-d-src-core, 7 steps | 1, 3 s |
| `slot-move.7` | m02 | SlotMove | the final copy's commit does not open the slot | the goal cannot be reached on d-r-moved | 10, 150 s |
| `slot-move.7` | n14 | SlotMoveMembers | the final copy's commit does not open the slot | the goal cannot be reached on mem-d-src-r | 5, 21 s |
| `slot-move.4` | m06 | SlotMove | the final copy is sent from a fence that has not committed | OneServer on d-core, 8 steps | 1, 2 s |
| `slot-move.4` | n06 | SlotMoveMembers | the final copy is sent from a fence some member holds but no one knows committed | OneServer on mem-d-src-core, 5 steps | 1, 2 s |
| `stream-numbers.4` | e01 | SlotMove | a leader reads the stream table and the sequence from its committed log, not its log end | PosUnique on d-core, 5 steps | 1, 2 s |
| `stream-numbers.4` | f02 | SlotMoveMsg | a leader reads the stream table and the sequence from its committed log | InOrder on msg-d-core, 5 steps | 1, 2 s |
| `stream-numbers.4` | g01 | SlotMoveMembers | a leader reads the stream table and the sequence from the log it knows committed | PosUnique on mem-d-src-core, 6 steps | 1, 2 s |
| `slot-move.13` | u28 | SlotMoveMsg | the target merges a delta onto a copy that stands at another place | InOrder on msg-d-early, 12 steps | 2, 5 s |
| `slot-move.13` | u29 | SlotMoveMsg | the source cuts the delta at the wrong place | InOrder on msg-d-early, 10 steps | 2, 5 s |
| `none` | u03 | SlotMoveMsg | a move's row does not hold the source's incarnation | the goal cannot be reached on msg-d-r-aftersrc | 13, 64 s |
| `none` | u05 | SlotMoveMsg | a recovered source fences a move ordered for its old life | **not caught** | 17, 235 s |
| `none` | u07 | SlotMoveMsg | a recovered target copies early for a move ordered for its old life | **not caught** | 17, 247 s |
| `none` | u08 | SlotMoveMsg | a move counts as ended though its target has had a new life since | **not caught** | 17, 328 s |
