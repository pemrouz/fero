# Planted mistakes

Made by `mutate.py` from `mutants.txt`. A mistake is caught when a property fails on a bound, or when a reach goal can no longer be reached.

## The new form's rules: 27 of 28 caught

Each line is a mistake in a rule of the one-number form. A good model catches it.

| id | model | rule | the mistake | caught by | bounds run |
|---|---|---|---|---|---|
| m01 | OneNumber | `take.before` | drop the guard "the number before is at or below the mark" | Truth on movedoor, 5 steps | 1, 2 s |
| m02 | OneNumber | `take.above` | drop the guard "the number is above the mark" | Once on movedoor, 7 steps | 1, 1 s |
| m03 | OneNumber | `take.before` | flip <= to < | the goal cannot be reached on reach | 9, 10 s |
| m04 | OneNumber | `take.above` | flip < to <= | Once on movedoor, 7 steps | 1, 1 s |
| m05 | OneNumber | `read.logend` | read the mark from committed entries only, not the log end | Once on movedoor, 7 steps | 1, 1 s |
| m06 | OneNumber | `mark.entry` | the entry does not raise the mark to the write's number | InOrder on movedoor, 4 steps | 1, 1 s |
| m08 | OneNumber | `dup.first` | answer a repeat "applied" instead of its first answer | Truth on movedoor, 6 steps | 1, 2 s |
| m09 | OneNumber | `dup.committed` | answer a repeat from an entry that has not committed | Truth on movedoor, 5 steps | 1, 1 s |
| m10 | OneNumber | `keep.floor` | flip >= to >: drop the answer at the floor | Truth on movedoor, 5 steps | 1, 1 s |
| m11 | OneNumber | `carry.hi` | the move does not carry the high marks | Once on movedoor, 11 steps | 1, 3 s |
| m12 | OneNumber | `carry.ans` | the move does not carry the kept answers | NoSkip on movedoor, 9 steps | 1, 2 s |
| m13 | OneNumber | `carry.seq` | the move does not carry the slot's own number | SlotSeq on movedoor, 11 steps | 1, 3 s |
| m14 | OneNumber | `open.table` | the open ignores the carried table | Once on movedoor, 11 steps | 1, 3 s |
| m17 | OneNumber | `number.before` | a write names nothing before it | Truth on movedoor, 5 steps | 1, 1 s |
| m18 | OneNumber | `number.order` | the client may send a write before it ever sent the one before | **not caught** | 10, 206 s |
| m19 | OneNumber | `number.before` | a write names a number refused at the door as the one before it | the goal cannot be reached on reachdoor | 10, 188 s |
| d01 | OneNumberDerived | `take.before` | drop the guard "the number before is at or below the mark" | Safe on d-small, 6 steps | 1, 1 s |
| d02 | OneNumberDerived | `take.above` | drop the guard "the number is above the mark" | Safe on d-small, 8 steps | 1, 1 s |
| d03 | OneNumberDerived | `take.before` | flip <= to < | CanFinish on d-small, the first state | 1, 1 s |
| d04 | OneNumberDerived | `take.above` | flip < to <= | Safe on d-small, 8 steps | 1, 1 s |
| d05 | OneNumberDerived | `read.logend` | read the mark from committed entries only | Safe on d-small, 8 steps | 1, 1 s |
| d06 | OneNumberDerived | `key.slot` | keep the mark per group, not per slot | CanFinish on d-small, 9 steps | 1, 2 s |
| d07 | OneNumberDerived | `open.table` | the open ignores the carried mark | Safe on d-small, 14 steps | 1, 3 s |
| d08 | OneNumberDerived | `carry.hi` | the move does not carry the mark | Safe on d-small, 14 steps | 1, 4 s |
| d09 | OneNumberDerived | `number.before` | a write names nothing before it | Safe on d-small, 6 steps | 1, 1 s |
| d10 | OneNumberDerived | `number.chain` | the deriver does not remember the last number it sent | Safe on d-small, 6 steps | 1, 1 s |
| d11 | OneNumberDerived | `number.start` | a new life goes on from the old life's last number | CanFinish on d-small, 2 steps | 1, 1 s |
| d15 | OneNumberDerived | `mark.entry` | the entry does not raise the mark to the write's number | Safe on d-small, 4 steps | 1, 1 s |

## Today's rules that stay: 9 of 9 caught

Rules of today that the form keeps as they are. The model must still need them.

| id | model | rule | the mistake | caught by | bounds run |
|---|---|---|---|---|---|
| k01 | OneNumber | `forward.once` | a relay forwards a copy twice (client-sessions.14 dropped) | DoorTrue on door, 5 steps | 5, 15 s |
| k02 | OneNumber | `first.only` | a resend is refused outside the log (client-sessions.7 dropped) | DoorTrue on movedoor, 6 steps | 1, 1 s |
| k03 | OneNumber | `recv.latest` | the client takes the answer to an old copy (client-sessions.1 dropped) | DoorTrue on movedoor, 6 steps | 1, 1 s |
| k04 | OneNumber | `stamp.next` | stamp the slot's next number from committed entries only (slot-sequence.1) | SlotSeq on movedoor, 7 steps | 1, 1 s |
| k05 | OneNumber | `new.session` | a restarted client keeps its session (client-sessions.2) | Truth on restart, 7 steps | 3, 9 s |
| k06 | OneNumber | `take.live` | take a write of a lapsed session, whose row is forgotten (client-sessions.5) | Once on lapse, 8 steps | 4, 12 s |
| k07 | OneNumberDerived | `marks.committed` | a new life reads marks from the uncommitted tail (srchi-marks.14) | Safe on d-small, 15 steps | 1, 4 s |
| k08 | OneNumberDerived | `marks.lowest` | a new life starts from the highest mark, not the lowest (srchi-marks.11) | Safe on d-small, 14 steps | 1, 3 s |
| k09 | OneNumberDerived | `number.source` | the number leaves out the write's place within its record (srchi-marks.9) | Safe on d-crash, 14 steps | 2, 21 s |

## A second check: mistakes on lines with no mark: 8 of 9 caught

Planted by a second reader, on lines of the world and of the client that hold no marked rule.

| id | model | rule | the mistake | caught by | bounds run |
|---|---|---|---|---|---|
| c01 | OneNumber | `-` | a copy carries the write's own number as the floor, not the lowest unanswered one | Truth on movedoor, 7 steps | 1, 1 s |
| c02 | OneNumber | `-` | a repeat exactly at the mark gets no answer (a stall only: the client model has no stall check) | **not caught** | 10, 150 s |
| c03 | OneNumber | `-` | the target opens the slot on a fence that has not committed | Truth on movedoor, 7 steps | 1, 1 s |
| c04 | OneNumber | `-` | a new life takes the answer to an old life's copy | Truth on retrylife, 7 steps | 8, 112 s |
| c05 | OneNumber | `-` | a write names the last answered number before it, not the last one made | Truth on movedoor, 5 steps | 1, 1 s |
| c06 | OneNumber | `-` | a new life takes the committed answer of an old life's write | Truth on restart, 6 steps | 3, 9 s |
| c07 | OneNumberDerived | `-` | a new life starts at the record after the lowest mark, not at the mark's own record | CanFinish on d-small, 14 steps | 1, 3 s |
| c08 | OneNumberDerived | `-` | the carried mark of the moved slot is read for every slot of the group | CanFinish on d-small, 11 steps | 1, 2 s |
| c09 | OneNumberDerived | `-` | the target opens the slot on a fence that has not committed | Safe on d-small, 10 steps | 1, 1 s |

## Probes: 0 of 1 caught

Changes the design says are harmless. They should NOT be caught.

| id | model | rule | the mistake | caught by | bounds run |
|---|---|---|---|---|---|
| x01 | OneNumber | `carry.floor` | the move does not carry the floors (memory only: should NOT be caught) | **not caught** | 10, 186 s |
