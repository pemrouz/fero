# Planted mistakes

Made by `mutate.py` from `mutants.txt`. A mistake is caught when a property fails on a bound, when a reach goal can no longer be reached, or when the stall check finds a state the writes cannot finish from. The safety bounds run first without `Whole` (the check that compares a final copy with the source directly), so a caught mistake names the end property it breaks.

## The move's own entries and guards: 21 of 23 caught

A good model catches each.

| id | rule | the mistake | caught by | runs |
|---|---|---|---|---|
| m01 | `slot-move.3` | the fence does not stop the source | OneTaker on core, 6 steps | 1, 1 s |
| m02 | `slot-move.7` | the final copy's commit does not open the slot | the goal cannot be reached on r-moved | 10, 72 s |
| m03 | `slot-move.1` | the source takes a write after its fence is in its log | Views on core, 9 steps | 1, 2 s |
| m04 | `slot-move.2` | the source fences a slot its committed log does not hold open | **not caught** | 23, 180 s |
| m05 | `slot-move.1 once` | the source fences a slot whose fence is already in its log | OneTaker on twice, 15 steps | 4, 15 s |
| m06 | `slot-move.4` | the final copy is sent from a fence that has not committed | OneServer on core, 6 steps | 1, 2 s |
| m07 | `slot-move.18` | the target takes a final copy after its abort | TableRight on core, 11 steps | 1, 2 s |
| m08 | `slot-move.8` | the target takes the final copy twice | Views on core, 11 steps | 1, 2 s |
| m09 | `slot-move.22` | the slot opens in a group that is a voter short | OpenFull on ver, 6 steps | 6, 25 s |
| m10 | `slot-move.15 whole` | the target opens with a part of the carried set missing | AnswersKept on core, 9 steps | 1, 2 s |
| m11 | `slot-move.5` | the final copy starts one record late | Views on core, 9 steps | 1, 2 s |
| m12 | `slot-move.5` | the final copy's records replace what the target holds | Views on crash, 11 steps | 2, 5 s |
| m13 | `slot-move.5` | the final copy sends records the target already holds | Views on crash, 11 steps | 2, 4 s |
| m14 | `slot-move.17` | the target aborts a move whose final copy is in its log | TableRight on core, 11 steps | 1, 2 s |
| m15 | `slot-move.19 fenced` | the source reopens on a fence that has not committed | **not caught** | 23, 254 s |
| m16 | `slot-move.19` | the source reopens on an abort that has not committed | OneTaker on lazy, 9 steps | 8, 40 s |
| m17 | `slot-move.19` | the source reopens with no abort | OneTaker on lazy, 7 steps | 8, 39 s |
| m18 | `slot-move.11` | the early copy takes records that have not committed | CopyTrue on crash, 4 steps | 2, 4 s |
| m19 | `stream-numbers.11` | the target opens without the carried table | AnswersKept on core, 9 steps | 1, 2 s |
| m20 | `moved.fence` | a fenced source answers retry, not moved | the stall check on s-lazy (home up: the writes can finish; home up: and the table names the server; home down: the writes can finish without it) | 13, 91 s |
| m21 | `moved.abort` | a target that gave up answers retry, not moved | the stall check on s-lazy (home down: the writes can finish without it) | 13, 89 s |
| m22 | `fence.once` | the source fences one move a second time | the stall check on s-twice (home up: the writes can finish; home up: and the table names the server; home down: the writes can finish without it) | 14, 165 s |
| m23 | `slot-move.17 target` | the source, not the target, aborts a move | TableRight on core, 11 steps | 1, 3 s |

## The carried set, one part at a time: 8 of 8 caught

Each part left behind must break something.

| id | rule | the mistake | caught by | runs |
|---|---|---|---|---|
| c01 | `slot-sequence.2 seq` | the move does not carry the slot's sequence | PosUnique on core, 11 steps | 1, 2 s |
| c02 | `slot-sequence.2 epoch` | the move does not carry the slot's epoch | PosUnique on core, 9 steps | 1, 2 s |
| c03 | `stream-numbers.10 marks` | the move does not carry the streams' high marks | Once on core, 11 steps | 1, 2 s |
| c04 | `stream-numbers.10 answers` | the move does not carry the kept answers | AnswersKept on core, 9 steps | 1, 2 s |
| c05 | `slot-move.6` | the move does not carry the highest lock token | TokOrder on lock, 11 steps | 5, 23 s |
| c06 | `slot-move.15 versions` | the move does not carry the row versions | VerRight on ver, 13 steps | 6, 28 s |
| c07 | `writer-time.7 carry` | the move does not carry the last stamp | StampOrder on core, 11 steps | 1, 2 s |
| c08 | `slot-move.15 rest` | the move does not carry the parts that are only bytes here | Whole on core, 7 steps | 15, 102 s |

## The slot table in the home log: 7 of 8 caught

The row, the write-back, and when a move has ended.

| id | rule | the mistake | caught by | runs |
|---|---|---|---|---|
| t01 | `slot-table.4 committed` | the source fences on a row that has not committed | RowFirst on core, 3 steps | 1, 1 s |
| t02 | `slot-table.4` | the source fences on a row that was written back | TableRight on twice, 17 steps | 4, 16 s |
| t03 | `slot-table.5` | the source reopens before the row is written back | TableRight on core, 9 steps | 1, 2 s |
| t04 | `slot-table.6` | the table keeps the last row written, not the highest version | **not caught** | 23, 165 s |
| t05 | `back.committed` | the row is written back on an abort that has not committed | TableRight on crash, 11 steps | 2, 5 s |
| t06 | `ended.back` | a move counts as ended once its abort commits, row or no row | TableRight on twice, 11 steps | 4, 15 s |
| t07 | `ended.open` | a move counts as ended on a final copy that has not committed | TableRight on twice, 19 steps | 4, 15 s |
| t08 | `move-policy.4` | the home group starts a second move while one is under way | TableRight on twice, 9 steps | 4, 13 s |

## Rules of other mechanisms the move leans on: 6 of 7 caught

The model must still need them.

| id | rule | the mistake | caught by | runs |
|---|---|---|---|---|
| k01 | `slot-table.1` | a leader takes writes for a slot its committed log does not hold open | **not caught** | 23, 167 s |
| k02 | `stream-numbers.4` | a write at or below the high mark is taken again | Once on core, 5 steps | 1, 1 s |
| k03 | `fence-tokens.1` | a write under an old lock token is taken | TokOrder on lock, 5 steps | 5, 16 s |
| k04 | `slot-sequence.1` | a record is stamped with the last sequence, not the next | PosUnique on core, 3 steps | 1, 1 s |
| k05 | `writer-time.7 stamp` | the target stamps by its own clock, below the carried stamp | StampOrder on core, 11 steps | 1, 2 s |
| k06 | `row-version.1` | a conditional write is applied whatever the row's version | VerRight on ver2, 7 steps | 7, 32 s |
| k07 | `home-records.2` | a group that never held the slot answers retry, not moved by its home records | the stall check on s-lazy (home up: the writes can finish; home up: and the table names the server; home down: the writes can finish without it) | 13, 85 s |

## Probes: 0 of 3 caught

Changes the model says are harmless. They should NOT be caught.

| id | rule | the mistake | caught by | runs |
|---|---|---|---|---|
| x01 | `slot-move.4 at` | the final copy reads the source's committed log today, not at the fence | **not caught** | 23, 164 s |
| x02 | `start.other` | the home group starts a move to the group that already holds the slot | **not caught** | 23, 202 s |
| x03 | `copy.server` | the early copy is taken from a group that no longer serves the slot | **not caught** | 23, 165 s |

## The second model (SlotMoveMsg): stored reports, the recovery, the early carried set: 48 of 56 caught

The rules a recovery needs, the delta and its merge, and the move's own guards again.

| id | rule | the mistake | caught by | runs |
|---|---|---|---|---|
| u01 | `recover.shut` | a recovered group goes on serving the slot from its cut log | OneServer on msg-rec, 2 steps | 4, 19 s |
| u02 | `meta-directory.2` | a recovery does not raise the group's incarnation | TableRight on msg-rec, 10 steps | 4, 18 s |
| u03 | `row.inc write-src` | a move's row does not hold the source's incarnation | the goal cannot be reached on msg-r-aftersrc | 11, 64 s |
| u04 | `row.inc write-dst` | a move's row does not hold the target's incarnation | the goal cannot be reached on msg-r-afterdst | 12, 78 s |
| u05 | `row.inc source` | a recovered source fences a move ordered for its old life | **not caught** | 14, 189 s |
| u06 | `row.inc target` | a recovered target takes a final copy ordered for its old life | TableRight on msg-rec, 10 steps | 1, 4 s |
| u07 | `row.inc copy` | a recovered target copies early for a move ordered for its old life | **not caught** | 14, 182 s |
| u08 | `ended.inc` | a move counts as ended though its target has had a new life since | **not caught** | 14, 183 s |
| u09 | `abort.lost` | a recovered target does not say its old life's records may be lost | NoBack on msg-rec, 14 steps | 1, 5 s |
| u10 | `back.lost` | the row written back after a lost target is an ordinary one | NoBack on msg-rec, 14 steps | 1, 4 s |
| u11 | `back.lost last` | a lost target's old move overrides a newer move into it | TableRight on msg-rec-three, 20 steps | 13, 100 s |
| u12 | `back.lost holder` | a lost target's old move overrides its own recovery row | **not caught** | 14, 173 s |
| u13 | `back.lost giver` | a move out of the lost target hides that the slot went back | NoBack on msg-rec-twice, 15 steps | 2, 12 s |
| u14 | `back.lost top` | the row written back after a lost target is not above the later rows | TableRight on msg-rec-twice, 16 steps | 2, 13 s |
| u15 | `back.epoch` | the row written back after a lost target keeps the old epoch | NoBack on msg-rec, 14 steps | 1, 4 s |
| u16 | `unf.epoch` | the source reopens in its old epoch after a lost target | NoBack on msg-rec, 14 steps | 1, 4 s |
| u17 | `unf.wait` | the source reopens after a lost target before the row is written back | the model stops with an error on msg-rec-lazy | 3, 23 s |
| u18 | `recover.copy` | a recovered group asks for a slot its copy does not hold | **not caught** | 14, 171 s |
| u19 | `recover.table` | a recovered group gets a row for a slot the table gives to another group | TableRight on msg-rec, 8 steps | 1, 2 s |
| u20 | `recover.final` | a recovered group gets a row though its copy is older than the last move into it | TableRight on msg-rec-twice, 9 steps | 2, 8 s |
| u21 | `slot-table.7` | a recovery writes the slot's row at the old epoch | NoBack on msg-rec, 7 steps | 1, 2 s |
| u22 | `recover.row` | a group reopens on the recovery row of an older life | NoBack on msg-rec2, 10 steps | 14, 124 s |
| u23 | `recover.epoch` | a recovered group reopens in its old epoch | NoBack on msg-rec, 7 steps | 1, 3 s |
| u24 | `fence.newer` | the source fences a move older than one it already acted on | InOrder on msg-rec-twice, 24 steps | 2, 23 s |
| u25 | `final.shut` | a group that holds the slot open takes a final copy | NoBack on msg-rec-twice, 19 steps | 2, 15 s |
| u26 | `final.newer` | a group takes the final copy of a move older than one it already acted on | OneTaker on msg-rec-three, 20 steps | 13, 88 s |
| u27 | `slot-move.14` | the target takes an early copy for the final copy | OneTaker on msg-early, 3 steps | 1, 2 s |
| u28 | `delta.base` | the target merges a delta onto a copy that stands at another place | InOrder on msg-early, 12 steps | 1, 2 s |
| u29 | `delta.base source` | the source cuts the delta at the wrong place | InOrder on msg-early, 10 steps | 1, 2 s |
| u30 | `slot-move.5` | the delta starts one record late | StateRight on msg-early, 10 steps | 1, 2 s |
| u31 | `delta.marks` | the delta leaves out the high marks that changed | StateRight on msg-early, 10 steps | 1, 2 s |
| u32 | `delta.answers` | the delta leaves out the new kept answers | StateRight on msg-early, 10 steps | 1, 2 s |
| u33 | `delta.rest` | a full final copy leaves out the parts that are only bytes here | StateRight on msg-crash, 6 steps | 2, 4 s |
| u34 | `slot-sequence.2 seq` | the delta carries the sequence of the early copy's place | StateRight on msg-early, 10 steps | 1, 2 s |
| u35 | `slot-sequence.2 epoch` | the delta does not carry the epoch | Whole on msg-early, 8 steps | 1, 2 s |
| u36 | `merge.seq` | the merge keeps the early copy's sequence | StateRight on msg-early, 10 steps | 1, 3 s |
| u37 | `merge.epoch` | the merge keeps the early copy's epoch | Whole on msg-crash, 6 steps | 2, 4 s |
| u38 | `merge.marks` | the merge drops the early copy's high marks | StateRight on msg-early, 10 steps | 1, 2 s |
| u39 | `merge.answers` | the merge drops the early copy's kept answers | StateRight on msg-early, 10 steps | 1, 2 s |
| u40 | `merge.rest` | the merge drops the early copy's byte parts | StateRight on msg-early, 8 steps | 1, 2 s |
| u41 | `slot-move.13 early` | the early copy does not hold the carried set | StateRight on msg-early, 8 steps | 1, 2 s |
| u42 | `slot-move.12 report` | the ready report names the wrong place | the goal cannot be reached on msg-r-early | 4, 14 s |
| u43 | `copy.forward` | a later early copy may stand before an earlier one | **not caught** | 4, 9 s |
| u44 | `slot-move.3` | the fence does not stop the source | OneTaker on msg-core, 5 steps | 1, 2 s |
| u45 | `slot-move.1` | the source takes a write after its fence is in its log | NoLoss on msg-core, 8 steps | 1, 2 s |
| u46 | `slot-move.18` | the target takes a final copy after its abort | TableRight on msg-core, 9 steps | 1, 2 s |
| u47 | `slot-move.8` | the target takes the final copy twice | **not caught** | 11, 93 s |
| u48 | `slot-move.17` | the target aborts a move whose final copy is in its log | TableRight on msg-core, 9 steps | 1, 2 s |
| u49 | `slot-move.19` | the source reopens on the abort of another move | OneTaker on msg-rec-twice, 10 steps | 5, 14 s |
| u50 | `slot-table.4` | the source fences on a row that was written back | **not caught** | 11, 95 s |
| u51 | `slot-table.6` | the table keeps the last row written, not the highest version | TableRight on msg-rec-twice, 16 steps | 5, 15 s |
| u52 | `move-policy.4` | the home group starts a second move while one is under way | TableRight on msg-rec-twice, 6 steps | 5, 13 s |
| u53 | `ended.open` | a move counts as ended with no final copy | TableRight on msg-rec-twice, 6 steps | 5, 13 s |
| u54 | `stream-numbers.11` | the target opens without the carried table | StateRight on msg-core, 6 steps | 1, 2 s |
| u55 | `stream-numbers.4` | a write at or below the high mark is taken again | InOrder on msg-core, 5 steps | 1, 2 s |
| u56 | `slot-sequence.1` | a record is stamped with the last sequence, not the next | InOrder on msg-core, 3 steps | 1, 1 s |

## The third model (SlotMoveMembers): a group with its members: 18 of 29 caught

The move's guards as a leader reads them, and the Raft rules the move leans on.

| id | rule | the mistake | caught by | runs |
|---|---|---|---|---|
| n01 | `slot-move.3` | the fence does not stop the source | OneServer on mem-src-core, 7 steps | 1, 3 s |
| n02 | `slot-move.1` | a leader takes a write after the fence is in its own log | Views on mem-src-core, 8 steps | 1, 3 s |
| n03 | `slot-table.1` | a leader takes a write for a slot the log it knows committed does not hold open | **not caught** | 9, 158 s |
| n04 | `slot-move.2` | a leader fences a slot the log it knows committed does not hold open | **not caught** | 9, 129 s |
| n05 | `fence.once` | a leader fences the move a second time | **not caught** | 9, 211 s |
| n06 | `slot-move.4` | the final copy is sent from a fence some member holds but no one knows committed | OneServer on mem-src-core, 5 steps | 1, 2 s |
| n07 | `slot-move.18` | a leader takes a final copy after an abort is in its log | OneServer on mem-src-core, 12 steps | 1, 4 s |
| n08 | `slot-move.8` | a leader takes the final copy twice | Views on mem-src-core, 11 steps | 1, 4 s |
| n09 | `slot-move.22` | the voters are counted in the committed configuration, not the newest in the leader's log | OpenFull on mem-dst-shrink, 10 steps | 4, 14 s |
| n10 | `slot-move.22` | the slot opens in a group that is a voter short | OpenFull on mem-dst-grow, 7 steps | 3, 8 s |
| n11 | `slot-move.17` | a leader aborts a move whose final copy is in its log | OneServer on mem-src-core, 12 steps | 1, 4 s |
| n12 | `slot-move.19 fenced` | a leader reopens on a fence it does not know committed | **not caught** | 9, 147 s |
| n13 | `slot-move.19` | a leader reopens on an abort some member holds but no one knows committed | OneServer on mem-dst-fault, 11 steps | 7, 30 s |
| n14 | `slot-move.7` | the final copy's commit does not open the slot | the goal cannot be reached on mem-src-r | 5, 17 s |
| n15 | `stream-numbers.11` | the target opens without the carried table | PosUnique on mem-src-core, 10 steps | 1, 2 s |
| n16 | `stream-numbers.4` | a write at or below the high mark is taken again | Once on mem-src-core, 6 steps | 1, 2 s |
| n17 | `raft-term-vote log` | a member votes for a candidate whose log is behind its own | RaftSafe on mem-dst-fault, 7 steps | 7, 23 s |
| n18 | `raft-term-vote term` | a member votes in a term it has already passed | the model stops with an error on mem-src-core | 1, 3 s |
| n19 | `raft-config.1` | a candidate wins without a majority of its configuration | the model stops with an error on mem-src-core | 1, 2 s |
| n20 | `raft-commit quorum` | a leader counts an entry committed on its own copy alone | RaftSafe on mem-dst-fault, 5 steps | 7, 23 s |
| n21 | `raft-commit term` | a leader commits an older term's entry by counting copies | **not caught** | 9, 96 s |
| n22 | `raft-log term` | a member takes the log of a leader from an older term | RaftSafe on mem-dst-fault, 7 steps | 7, 28 s |
| n23 | `raft-config.5` | a leader proposes a membership change while one is not committed | **not caught** | 10, 143 s |
| n24 | `raft-config.2` | a new leader proposes a membership change before it has committed in its term | **not caught** | 10, 131 s |
| n25 | `raft-config.12` | a member outside its configuration stands for election | **not caught** | 9, 88 s |
| n26 | `raft-config.10` | a leader its change removed goes on leading | **not caught** | 9, 90 s |
| n27 | `raft-config.13` | a configuration takes effect when it is appended | **not caught** | 9, 86 s |
| n28 | `learners.3` | a member is made a voter before its log has caught up | **not caught** | 9, 85 s |
| n29 | `raft-config.3` | a new leader adds no entry of its own term | the goal cannot be reached on mem-dst-r | 6, 6 s |
