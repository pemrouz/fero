# Probe P5: one number for "a write applied once, in order"

Slice 0, probe P5 (BUILD 3.3; READY section 2). A model study. No product code.

Each claim below is marked: *(counted)* from the ledger or the record, *(checked)* by the model checker on every reachable state at the stated bounds, *(measured)* a time or a state count from a run here, or *(reasoned)* argued and not run.

## The question

Can one number per stream replace the five high marks, 32 rules?

A **stream** is one writer's writes to one slot. A **high mark** is the highest number a copy of the slot has taken from that stream. Today five mechanisms each keep a mark of their own, so that a write is applied once and in order.

**Kill line:** no saving of 3 rules or more, or a model fails. If killed, the five marks stay.

**Verdict: pass, but thin on the study's own count** (see "The second check"). The one-number form holds every property on every bound *(checked)*, and it needs fewer rules: 46 become 33 in today's ledger, a saving of 13 *(counted)*. On the study's own, finer count the same change takes the 32 to between 27 and 29, a saving of 3 to 5 *(counted)*. The low end is the kill line's edge. Details in "Rules before and after".

## The five mechanisms and the 32 rules

The 32 is the study's count, from `judging/simplicity.json`: it holds all five, `issue-order` as a reasoned 3 (low 1, high 4; LAYERS 0.2 has the same 3) *(counted; counted again by a second reader)*. READY names the 32 and the five but not which five; these are the five whose counts add to 32 *(reasoned)*.

| Mechanism | What its high mark is | Study's rules | Today's ledger |
|---|---|---|---|
| `issue-order` | per writer and slot: the last issue number taken | 3 | 4 |
| `slot-sequence` | per slot: the last sequence, with its epoch | 2 | 2 |
| `client-sessions` | per session: the floor and the outcomes above it | 14 | 14 |
| `caller-keys` | per once name: the first answer | 8 | 11 |
| `srchi-marks` | per reader, source slot and output slot: the last source record applied | 5 | 15 |
| | | **32** | **46** |

The study's 32, by name *(counted)*:

- `issue-order` (3): each writer numbers its writes to a partition; the leader takes write n only after n-1; a later one is refused `gap`.
- `slot-sequence` (2): `write.pos`, `final.seq`.
- `client-sessions` (14): `recv.latest`, `restart.life`, `apply.notin`, `apply.floor`, `apply.live`, `refuse_r.notin`, `refuse_f.first`, `stale.floor`, `expired.dead`, `fence.outs`, `fence.floor`, `open.outs`, `open.floor`, `forward.once`.
- `caller-keys` (8): the claim, the holder, the stored result, the retry, the re-run after the lease, the fence on the key, the TTL, the binding to the caller's session.
- `srchi-marks` (5): `commit.acked`, `apply.above`, `apply.mark`, `fence.carry`, `open.carry`.

The ledger has grown since: `srchi-marks` took 10 rules from E-57 and E-61, `caller-keys` 3 from the API, `issue-order` its carry rule. So the same five hold 46 ledger rules today *(counted from `spec/ledger.json`)*.

**The models they rest on.** All are exhaustive models in Python on the study's own engine, not TLA+: E-20 (sessions and the other dedup options), E-30 and E-61 (marks), E-17 and E-17c (the slot sequence, inside the slot-move models), E-48 (issue order, on another system's shape, with no move). The model of issue order across a move is owed (LAYERS 11). READY says three models run again; it does not name them. The three that hold these marks are the dedup model, the marks model and the slot model. This probe writes their worlds again, in TLA+, as two models.

## The one-number form

**The number.** Each writer numbers its own writes to a slot, with rising numbers.

| Writer | Its stream to a slot | Its numbers |
|---|---|---|
| a client session | the session's writes to the slot | 1, 2, 3, ... in the order it makes them |
| a deriver (`{ from: e }`) | one reader's outputs from one source slot | the source record's sequence and the write's place within the record |
| a once name | the writes made under the name | 1, 2, 3, ... the same on every run |
| the slot's leader | every record of the slot | the slot sequence: 1, 2, 3, ... |

**What a write carries.** Its stream, its number, and **the number before it**: the last number the writer made for this slot that was not refused outside the log. For a client that is n-1 almost always. For a deriver it is the last output it sent to this slot, or 0 for the first one after a restart.

**What each copy keeps.** One number per stream per slot: the high mark. It is in the log entry of every taken write, so every copy folds the same mark. Beside it, the answers of the writes the writer has not yet seen answered, so a repeat gets its first answer.

**The take rule.** The leader takes a write only if

    before <= high mark < number

read at its log end. That one comparison pair does three jobs.

- **Once.** A repeat has `number <= high mark`. It is never judged again.
- **In order.** A write that is not above the mark is not taken.
- **No gap.** A write whose `before` is above the mark comes after one that was lost. It is refused `gap` and changes nothing.

**How each case carries it.**

- **A retry** sends the same number and the same `before`, unless the write before it was refused outside the log since: then the new copy names the number before the refused one. If the first copy was taken, the retry is at or below the mark and gets the first answer.
- **A leader change.** The mark is read from the log. A new leader has it at its own log end.
- **A restart.** A client takes a new session, so a new stream from 1. A deriver reads the committed marks, starts again from the lowest, and names 0 as the number before its first write to each slot. Writes the old life already landed are at or below the mark and are skipped.
- **A moved slot** carries its stream table: every stream's mark and kept answers, and the slot's own sequence and epoch. The target opens the slot with it.
- **A client session.** When the session lapses by a committed entry of `#sessions`, its rows are forgotten and its writes are answered `unknown`. That is today's rule, unchanged.
- **A refusal on the row** (a failed condition, a shape check) goes in the log and takes its number, like an apply. **A refusal outside the log** (forbidden, fenced, or today's first-send refusal) takes no number: the writer's next write names the number before the refused one. Today's three rules for a refusal outside the log stay as they are.

**What it costs** *(reasoned)*. On the wire a plain write carries its stream, its number, the number before and the floor. Today it carries a session, an attempt id, an issue number and the floor. A marked write no longer needs a session's attempt id or issue number beside its mark. In memory a copy keeps one number per stream per slot plus the kept answers, where today it keeps a floor, the outcomes, an issue number and, for a deriver, a mark.

## The models

Two TLA+ models. Each line that holds a rule of the form is marked `@rule <name>`. Each line that holds a rule of today that stays is marked `@keeps <name>`.

**[OneNumber.tla](OneNumber.tla)**: a client's stream, and the slot's own number. The world is E-20's, written again:

- Two abstract Raft groups. A leader change may drop any part of the uncommitted tail. A dropped tail may come back until the next commit.
- One slot. It starts in g0 and may move to g1 by a fence and an open (the three-step move of E-15 and E-17).
- One client. It may send write n+1 before n is answered. Each copy may arrive late, never, or twice (a relay). The client may restart; the old life's copies stay in flight. A session may lapse.
- A leader applies a copy, refuses it on the row (both in the log), or refuses a first send outside the log.

Properties *(each an invariant)*:

| Name | What it says |
|---|---|
| `Once` | no write is committed twice |
| `InOrder` | a stream's committed numbers rise in log order, across the move, and skip only writes refused outside the log (order, and no gap) |
| `SlotSeq` | the slot's positions are 1, 2, 3, ... across the move: no position names two records |
| `Truth` | what the client was told (applied, refused) is in the committed log as a write of its own life |
| `DoorTrue` | a write told "refused outside the log" is never in the committed log |
| `NoSkip` | a client is never answered `skipped` for a write it holds no answer to |
| `Shape` | no write sits after the fence, or before the open |

**[OneNumberDerived.tla](OneNumberDerived.tla)**: a deriver's stream. The world is E-30's and E-61's, written again:

- Three source records, already committed. Two output slots. Slot X stays in group b0. Slot Y starts in b1 and may move **into** b0, beside X.
- Record 1 writes to X and Y. Record 2 writes twice to Y and sends X a bare mark. Record 3 writes to X and sends Y a bare mark. So the numbers have holes, and one record has two outputs in one slot.
- A life of the deriver sends each write once and awaits nothing. Copies arrive in any order, once, or never. A new life reads the committed marks and starts from the lowest.
- Leader changes as above.

Properties *(each an invariant)*:

| Name | What it says |
|---|---|
| `Safe` | what a slot has committed is the first part of what the deriver makes for it: no output twice, none out of order, none missing before a later one (E-30's ONCE and LOST in one) |
| `CanFinish` | a check for a stall: from every state, if a new life starts now and nothing else goes wrong, every slot ends with all its outputs. The model plays that calm run with its own take rule and its own start of a life |

Both models also have a **reach check**: a goal state (every write lands, the slot has moved) must be reachable. It guards against a model that is safe because nothing can happen.

### Bounds and results

One box, 4 cores, 15 GB, shared with one other job. TLC2 2026.11.19 on Java 21, 2 workers, a 3 GB heap. Every run is complete: every reachable state at its bound *(checked; states and times measured)*.

**OneNumber** (the client and the slot's own number)

| Bound | Writes | Copies | Leader changes | Twice by a relay | Lives | Move | Lapse | Refusal outside the log | Result | Distinct states | Depth | Time |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `movedoor` | 2 | 2 | 1 | 0 | 1 | yes | no | yes | pass | 16,849 | 17 | 2 s |
| `move` | 2 | 2 | 1 | 1 | 1 | yes | no | no | pass | 48,320 | 17 | 3 s |
| `restart` | 2 | 1 | 1 | 0 | 2 | no | yes | yes | pass | 56,952 | 19 | 2 s |
| `lapse` | 2 | 2 | 1 | 0 | 1 | no | yes | no | pass | 3,667 | 14 | 2 s |
| `door` | 3 | 2 | 1 | none (by rule) | 1 | no | no | yes | pass | 78,633 | 18 | 4 s |
| `lost` | 3 | 2 | 2 | 1 | 1 | no | no | no | pass | 595,277 | 19 | 33 s |
| `all` | 2 | 1 | 1 | 0 | 2 | yes | yes | yes | pass | 673,145 | 25 | 14 s |
| `reach` | 2 | 1 | 0 | 0 | 1 | yes | no | no | goal reached | 314 | 13 | 1 s |
| `reachdoor` | 2 | 1 | 0 | 0 | 1 | no | no | yes | goal reached | 73 | 9 | 0 s |
| `big-door` | 3 | 2 | 2 | none (by rule) | 1 | no | no | yes | pass | 148,161 | 18 | 9 s |
| `big-movedoor` | 3 | 2 | 2 | 0 | 1 | yes | no | yes | pass | 1,604,867 | 23 | 57 s |
| `big-move` | 3 | 2 | 2 | 1 | 1 | yes | no | no | pass | 5,974,273 | 23 | 294 s |
| `big-lost` | 3 | 3 | 1 | 1 | 1 | no | no | no | pass | 7,643,766 | 23 | 763 s |
| `big-restart` | 2 | 2 | 1 | 0 | 2 | no | yes | yes | pass | 12,787,024 | 25 | 315 s |

**OneNumberDerived** (the deriver)

| Bound | Source records | Lives | Leader changes | Move | Result | Distinct states | Depth | Time |
|---|---|---|---|---|---|---|---|---|
| `d-small` | 2 | 2 | 1 | yes | pass | 650,008 | 32 | 45 s |
| `d-crash` | 3 | 2 | 2 | no | pass | 1,683,399 | 38 | 135 s |
| `d-move` | 3 | 2 | 1 | yes | pass | 23,239,925 | 42 | 1552 s |
| `d-reach` | 3 | 1 | 0 | yes | goal reached | 5,762 | 26 | 2 s |
| `d-lives` | 2 | 3 | 1 | yes | pass | 25,061,940 | 38 | 1559 s |

"Goal reached" is the reach check: the run ends at the first state where every write has landed (and the slot has moved, where it may), so its state count is small. "None (by rule)" means the bound allows a relay to forward twice, and the kept rule `forward.once` forbids it there; the planted mistake k01 needs that room.

**A dropped tail can come back only where a bound allows 2 leader changes**: the coming back is the second change *(checked by a second reader: the step needs a change left to spend)*. In the first set that was `lost`, `big-door`, `big-movedoor`, `big-move` and `d-crash`: never beside a restart or a lapse, and never beside the deriver's slot move. Also, the two-life bounds `restart` and `all` send one copy of each write, so they hold no retry. The second check added six bounds for these holes; all pass *(checked; 1 worker)*:

| Bound | Model | What it adds | Result | Distinct states | Depth | Time |
|---|---|---|---|---|---|---|
| `retrylife` | OneNumber | 2 writes, 2 copies, 2 lives: a retry beside a restart | pass | 441,270 | 21 | 65 s |
| `back-restart` | OneNumber | `restart` with 2 leader changes | pass | 101,256 | 21 | 5 s |
| `back-lapse` | OneNumber | `lapse` with 2 leader changes | pass | 6,609 | 14 | 2 s |
| `back-mix` | OneNumber | 1 write, 2 copies, 2 lives, 2 leader changes, a move, a lapse, a refusal outside the log | pass | 123,188 | 20 | 6 s |
| `d-back` | OneNumberDerived | `d-small` with 2 leader changes: a tail comes back beside the slot move | pass | 2,200,686 | 33 | 211 s |
| `big-moveretry` | OneNumber | 2 writes, 2 copies, 2 lives, 1 leader change, a move: the part of `deep-all` without the lapse and the refusal outside the log | pass | 21,317,116 | 27 | 1957 s |

Times are wall-clock with 2 workers (3 for `big-restart`), some beside another job, so read them as rough. The longest complete run is 26 minutes.

**One bound did not finish and is not counted.** `deep-all.cfg` (2 writes, 2 copies, 1 leader change, 2 lives, a move, a lapse and a refusal outside the log) was stopped at the one-hour limit after 96,993,242 distinct states, at depth 24, with about 10.5 million states still waiting. No property had failed in the part explored *(measured)*. That is not a pass. `run.sh` does not run it. The same mix at 1 copy is bound `all`; the same mix without the move is `big-restart`; both are complete.

**One run failed on the way, and it was the world that was wrong, not the form.** The first version let a relay forward a copy twice in the same world where a first send may be refused outside the log. Bound `big-door` then broke `DoorTrue` in 7 steps: the copy's first arrival is taken into a leader's tail; the leader changes and the tail is dropped; the copy's second arrival is refused outside the log and the client is told so; the old tail comes back and commits. Today's rule `client-sessions.14` forbids exactly that second arrival. With the rule stated in the model as it is in the ledger (no copy is forwarded twice while some refusal is outside the log) every bound passes, `big-door` included *(checked)*. The trace needs no part of the one-number form: today's design has the same hole without that rule *(reasoned; E-20 found the same rule needed, in 9 steps)*.

### Planted mistakes

[mutants.txt](mutants.txt) lists one-line mistakes on the marked rule lines, of the study's kinds (DEV-10 d): drop a guard, flip `<` and `<=`, drop or weaken an update, read the wrong place. [mutate.py](mutate.py) plants each one in a copy of the model and runs the bounds, small first. A mistake is caught when a property fails, or when the reach goal can no longer be reached. The full table with the failing property and the trace length is in [results/mutants.md](results/mutants.md).

| Group | Planted | Caught |
|---|---|---|
| The new form's rules (ids m and d) | 28 | **27 (96 %)** |
| Today's rules that stay (ids k) | 9 | 9 |
| Probes: changes the design calls harmless (ids x) | 1 | 0, as expected |
| The second check: lines with no mark (ids c) | 9 | 8 |

All *(measured)*. DEV-03 asks for 85 %. Each mistake's runs took 1 s to about 3.5 minutes (1 worker, beside other jobs).

The one that was not caught:

- **m18, `number.order`**: the client may send write n before it ever sent n-1. No property breaks, because the leader's gap rule refuses n until n-1 lands. So "send in order" is not a safety rule of the form. It only saves a refused round trip. It is not counted in the 8.

One mistake was first missed, and the model was made stronger for it. **d11**: a new life of the deriver names the old life's last number, not 0, before its first write. Nothing wrong lands, so `Safe` holds. But if the old life's last write was lost, the new life is refused `gap` for ever. The first version of the model had no check for a stall and passed it on every bound. `CanFinish` was added for it and catches it in 2 steps. The client model has no such check (see "What is not checked").

The probe **x01** drops the floors from what a move carries. It is not caught on any bound, which is the claim: in this form the floor only bounds memory.

Three checks on rules of today are worth a line each, because they say what must stay:

- With some refusals outside the log, a relay that forwards a copy twice breaks `DoorTrue` in 5 steps (k01), a resend refused outside the log breaks it in 6 (k02), and a client that takes an old copy's answer breaks it in 6 (k03).
- A mark kept per group, not per slot, breaks when slot Y moves in beside slot X: a stall in 9 steps, and a lost output in 12 on the first version of the model (d06). E-30 found the same.
- A mark read from committed entries only, not from the log end, applies a write twice (m05, 7 steps). E-61 found the same.

## Rules before and after

**After: 8 rules.** One sentence each. They would sit in one new mechanism (here called `stream-numbers`). In them a **stream** is one writer's writes to one slot: a session's, a reader's from one source slot, a once name's, or the slot leader's own.

| # | The rule | Model lines | Replaces (ledger ids) |
|---|---|---|---|
| 1 | Each writer numbers its writes to a slot in the order it makes them, with rising numbers, and each write names its own number and the last number before it that was not refused outside the log. | `number.before`, `number.chain`, `number.start` | `issue-order.1` |
| 2 | The leader takes a write only if, at its log end, the stream's high mark is at or above the number the write names before it and below the write's own number; an apply, a refusal on the row and a bare mark alike. | `take.before`, `take.above`, `read.logend`, `key.slot` | `issue-order.2`, `client-sessions.3`, `client-sessions.4`, `srchi-marks.2` |
| 3 | A taken write's log entry holds its stream and its number, so the write and its new high mark commit together. | `mark.entry` | `srchi-marks.3` |
| 4 | A write that names a number before it above the high mark is refused `gap` and changes nothing, and the writer sends again, in order, from the first lost one. | `take.before` | `issue-order.3` |
| 5 | A write at or below the high mark is never judged again: it gets its first answer if that answer is kept and committed, else `skipped`, never `applied`. | `take.above`, `dup.first`, `dup.committed` | `client-sessions.6`, `client-sessions.8`, `srchi-marks.7`, `srchi-marks.8`, `caller-keys.10` |
| 6 | The leader keeps a taken write's answer until the stream's floor, the writer's lowest unanswered number carried on every copy, has passed it. | `keep.floor` | (the floor half of `client-sessions.4`) |
| 7 | A slot move carries the slot's stream table: every stream's high mark and kept answers, and the slot's own epoch and sequence. | `carry.hi`, `carry.ans`, `carry.seq` | `issue-order.4`, `slot-sequence.2`, `client-sessions.10`, `client-sessions.11`, `srchi-marks.4`, `caller-keys.11` |
| 8 | The target group opens the slot with the carried table. | `open.table` | `client-sessions.12`, `client-sessions.13`, `srchi-marks.5` |

**Replaced: 21 ledger rules** *(counted)*: `issue-order.1` to `.4`; `slot-sequence.2`; `client-sessions.3`, `.4`, `.6`, `.8`, `.10`, `.11`, `.12`, `.13`; `srchi-marks.2`, `.3`, `.4`, `.5`, `.7`, `.8`; `caller-keys.10`, `.11`.

**Kept as they are: 25 ledger rules** *(counted)*.

- `slot-sequence.1`: the leader stamps the slot's next number from the log end. The slot's own stream is a row of the same table; its stamp is still a rule (`stamp.next`, *checked*: mistake k04).
- `client-sessions.1`, `.7`, `.14`: the three rules for a refusal outside the log (`recv.latest`, `first.only`, `forward.once`). The model needs all three as long as some refusal stays outside the log (*checked*: k01 to k03).
- `client-sessions.2`, `.5`, `.9`: a restart takes a new session; no write of a lapsed session; `unknown` only once the lapse has committed. The first two are *checked* (k05, k06); the third is not modelled.
- `caller-keys.1` to `.9`: the claim in `#calls`, the lease, the fence, the TTL, `call-diverged`. They are about running a handler once, not about a high mark. Not modelled.
- `srchi-marks.1`, `.6`, `.9` to `.15`: the consumer's cursor, which refusals raise the mark, what the number is made of, the 256 limit, `marks(name)`, bare marks at joined slots, pacing, the type rules. Of these the model checks what the number is made of (`.9`, k09), that a new life starts from the lowest mark (`.11`, k08) and reads committed marks only (`.14`, k07). The others are not modelled.

| Mechanism | Ledger today | After |
|---|---|---|
| `issue-order` | 4 | 0 |
| `slot-sequence` | 2 | 1 |
| `client-sessions` | 14 | 6 |
| `caller-keys` | 11 | 9 |
| `srchi-marks` | 15 | 9 |
| `stream-numbers` (new) | 0 | 8 |
| | **46** | **33** |

**Saving: 13 ledger rules** *(counted)*.

**The same change on the study's count of 32** *(counted)*. The study counts one guard or one update as one rule (DEV-10 c), which is finer than a ledger sentence. At that grain the form replaces 16 of the 32: the 3 of `issue-order`; `final.seq`; `apply.notin`, `apply.floor`, `refuse_r.notin`, `stale.floor`, `fence.outs`, `fence.floor`, `open.outs`, `open.floor`; `apply.above`, `apply.mark`, `fence.carry`, `open.carry`. In their place the client model has 11 guards and updates, each one shown needed by a planted mistake: `number.before`, `take.before`, `take.above`, `mark.entry`, `dup.first`, `dup.committed`, `keep.floor`, `carry.hi`, `carry.ans`, `carry.seq`, `open.table`. The deriver's side of "the number before" has two more lines, each also shown needed: it remembers the last number it sent to a slot (`number.chain`), and it names 0 after a restart (`number.start`). Counted as part of `number.before` the total is 11; counted apart it is 13. Reading the mark at the log end (`read.logend`) and keeping it per slot (`key.slot`) are in today's rules too and are counted on neither side. So **32 becomes 27 to 29, a saving of 3 to 5**. READY guessed 3 to 8.

**How firm the ledger count is** *(reasoned)*. A ledger rule is one sentence, and sentences can be cut finer. Rule 1 could be two (number in order; name the number before) and rule 5 could be two (never judged again and answered `skipped`; the first answer if it is kept). Then the form is 10 rules and the saving is 11, not 13. The first count found no fair cut under 11. A second reader's stricter cut gives 7 to 9: see "The second check".

**Where the saving comes from** *(reasoned from the two tables)*.

- Five carry-out rules and four open rules become one of each, because there is one table to carry (9 become 2).
- "Not among the outcomes", "at or above the floor", "above the stored mark" and "the next issue number" become one comparison pair (4 become 1).
- "A repeat gets its first answer", "below the floor is stale", "at or below the mark is skipped", "skipped is never applied" and "a once name keeps its first answer" become one rule (5 become 1).
- The floor stops being a safety rule. It only says which answers may be dropped. A move that does not carry the floors breaks nothing (probe `x01`, *checked*).

## Verdict against the kill line

| Kill condition | Result |
|---|---|
| No saving of 3 rules or more | **Not met on the ledger.** 13 as cut here, 7 to 9 on the second reader's strictest cut *(counted)*. **On the study's count it is at the line:** 3 to 5 here, 2 to 5 on the second reader's count *(counted)* |
| A model fails | **Not met.** Every bound passes; every reach goal is reachable *(checked)* |

**Pass.** DEV-03's bar for the models (85 % of planted mistakes caught, each run under an hour) is met *(measured)*: 27 of 28, and the longest counted run is 26 minutes. The probe took about three and a half hours of wall clock, start to end *(measured)*.

Two things the lead should know before taking it.

1. **It is one design for two shapes of number.** A client's numbers are 1, 2, 3. A deriver's have holes. Naming "the number before" on each write is what lets one rule serve both. Without it the deriver would need a second number (today's issue number beside the mark).
2. **Three more rules could go, at a price that was not taken.** If every final refusal went in the log, `client-sessions.1`, `.7` and `.14` would not be needed: with no refusal outside the log the model holds with a relay that forwards twice and a client that takes any answer (bounds `lost` and `move`, *checked*). But a forbidden write would then cost a log entry, which a flood could abuse *(reasoned)*. So the form keeps refusals outside the log, and keeps the three rules.

## The second check

A second reader went over this probe to break it. What it found *(each marked)*:

- **The count of today holds.** 3 + 2 + 14 + 8 + 5 = 32 in `simplicity.json`, and 4 + 2 + 14 + 11 + 15 = 46 in the ledger *(counted again)*.
- **Every run passes again with the same state counts** *(checked; see `results/runs.txt`)*.
- **Two holes in the bounds**, now filled (the six bounds above): no bound brought a dropped tail back beside a restart, a lapse or the deriver's move, and no small two-life bound held a retry.
- **Nine more planted mistakes**, on lines with no mark (ids c in [mutants.txt](mutants.txt)): 8 of 9 caught *(measured)*. c04, a new life that takes the answer to an old life's copy, passed every small bound of the first set; `retrylife` catches it in 7 steps. c02, a repeat exactly at the mark that gets no answer, is not caught: it is a stall, and the client model has no stall check (as "What is not checked" says).
- **Reach, with faults on.** A state with both lives' writes committed, a refusal outside the log, the slot moved and both leader changes spent is reachable; so is an `unknown` answer; so is the deriver's goal after a restart and two leader changes beside the move *(checked on scratch copies; not in `run.sh`)*.
- **The count after is too kind in two places** *(reasoned)*.
  - Rule 7 holds `slot-sequence.2` as a clause. The slot's own number has no "number before" and no take rule; the leader stamps it. It is today's rule, kept, not a row of the table (the model needs `carry.seq` apart from `carry.hi`: m13).
  - Rule 1 hides one rule of the deriver: a new life names 0, not its last number, before its first write to each slot (`number.start`; d11 shows it is needed).
  - With those two, and rules 1 and 5 cut in two, the form is 12 rules: 46 become 37, a saving of 9. Once names are not modelled; if `caller-keys.10` and `.11` are kept until they are, the saving is 7.
- **The study's count can fall to 2** *(reasoned)*. "Each writer numbers its writes in order" is one of the 16 counted as replaced, but a writer still numbers its writes in the new form. Counted on both sides, or on neither, 15 become 11 to 13: a saving of 2 to 4. So the study's count gives 2 to 5, not 3 to 5.

**What this means for the verdict.** No model fails. On the ledger, the grain the build's budget is cut in, the saving is 7 to 13: a pass. On the study's own grain, the grain the "32" is in, the saving is 2 to 5: at the line, and under it on the strictest count. The kill line does not say which grain it means. That is the lead's call.

## What is not checked

- **Liveness.** Only safety, that a goal state is reachable, and for the deriver one calm run from every state (`CanFinish`). "Every write is answered in the end" is not checked, and the client model has no stall check at all. A mistake that only stalls a client could pass.
- **Unclean recovery and epochs.** The groups are crash-only, as in E-20 and E-17. The epoch half of `slot-sequence.2` is carried in rule 7 but not modelled.
- **The one-commit move.** The move here is the fence and the open. The one-commit move's model is owed elsewhere (READY M6).
- **Real Raft.** A group is abstract: a log, a commit point, a tail that may be dropped and may come back. `#sessions` is one committed flag per session; its follow lag and an uncommitted lapse (`client-sessions.9`) are not modelled.
- **Once names.** A once-named write is the one-write case of the client model (N = 1 is inside every bound). A call's re-run with the same numbers is the deriver's case. The claim, the lease, the fence and the TTL of `#calls` are not modelled, and nor is a name forgotten after its TTL.
- **The rest of the marks.** The consumer's cursor, `marks(name)` over joined slots, pacing, a `fenced` marked write, and the 256-output packing are E-61's and are not modelled again. An old life of the deriver that keeps sending beside the new one is not modelled; its copies in flight are.
- **Answer stages.** Only the committed answer. E-48's early answers lean on issue order harder and are not modelled here.
- **Splits, merges and re-keys.** Only a slot move.
- **Small bounds.** Up to 3 writes, 3 copies, 2 leader changes, 2 client lives or 3 deriver lives, one move, and never all at once. A pass is a pass at these bounds. The biggest mix (`deep-all`) did not finish in an hour.
- **Speed and bytes.** Nothing was timed. The wire and memory notes are reasoned.
- **One modeller, hand-listed mistakes.** The mistakes follow the study's kinds but were listed by hand on the marked lines, not made by a script from the whole model text, and no second count was made (DEV-10 d and e).

## Files

| File | What it is |
|---|---|
| [OneNumber.tla](OneNumber.tla), [OneNumberDerived.tla](OneNumberDerived.tla) | the two models |
| `*.cfg` | one bound each; `reach`, `reachdoor`, `d-reach` are the reach checks; `deep-all` is the bound that did not finish |
| [mutants.txt](mutants.txt), [mutate.py](mutate.py) | the planted mistakes and their runner (ids c are the second check's) |
| [run.sh](run.sh) | reruns every model: `TLA_JAR=<the tools jar> ./run.sh`, `./run.sh big`, `./run.sh mutants` |
| [results/](results) | `runs.txt` (one line per run reported here), `mutants.md` and `mutants.json` |
