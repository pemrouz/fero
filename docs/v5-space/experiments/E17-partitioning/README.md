# E-17 (part 1): how many rules each way of mapping partitions onto groups needs

**Question (Q-17).** Measured, not guessed: how complex is each way of mapping partitions onto groups? This is part 1 of 2. It builds the **shared harness** every option is checked on, and checks the first three options on it: **fixN** (a fixed group count), **fixN + re-key** (grow by copying into a new generation; two cursor designs, `rekey` and `rekey-carry`), and **slot moves**. Part 2 (another agent) adds `pslot`, `split` + merge, and lanes + range moves on the same harness ([HARNESS.md](HARNESS.md) tells it how). A third agent re-runs every ablation.

## The answer, first

All counts are **model-checked here** on one harness, at the same bounds, as REQUIREMENTS DEV-10 counts rules: a rule counts only if removing it lets the checker find a counterexample.

| Option | Rules as written | **Necessary** (smallest set found) | Beyond fixN's 13 | With a working give-up path | Mutants caught (equivalent; survived) | States as written / smallest, `shrink` bound |
|---|---|---|---|---|---|---|
| fixN | 14 | **13** | 0 | none to give up | 17 of 18 (1; 0) | 28 / 28 |
| slot moves | 69 | **26** | 13 | GU_SLOT | 35 of 46 (11; 0) | 22,797 / 1,086 |
| fixN + re-key (`rekey`, CELL as written: old cursors refused) | 57 | **35** (34 in another greedy order) | 22 (21) | GU_REKEY | 44 of 53 (8; 1) | 312,298 / 4,417 |
| fixN + re-key with carried positions (`rekey-carry`) | 51 | **29** (28 in another greedy order) | 16 (15) | as `rekey` | 38 of 45 (7; 0) | 312,298 / 4,417 |

- **fixN is the floor: 13 rules.** Every option pays them: one route, two dedup, two lock-token, one stamping, two answer and five reader rules. fixN meets no scale requirement (SC-03, SC-04), by definition.
- **Slot moves need 13 rules beyond the floor.** The smallest move that keeps every property is: A commits `exporting`; A fences (and from the moment the fence is in its log takes no write); once the fence commits, B takes one final copy carrying the rows and records, the dedup outcomes, the highest lock token, the sequence and `END(N)`; B opens. B's `importing` entry, the bulk copy, the ready report and N in the fence are not needed by any property here. They serve the unwritable window, the give-up path and unclean recovery.
- **Re-key needs 22 rules beyond the floor, 9 more than slot moves.** Six of the 22 exist only to refuse an old cursor and restart the reader from a snapshot. Carrying each record's position in the copy (`rekey-carry`) removes all six and adds no rule, so re-key's broken cursors are a design choice, not a cost of re-keying. Even then, re-key needs 3 more rules than slot moves. They come from the generation: a new generation must wait for its flip, and a second re-key must copy from the current generation and wait for the first.
- **Re-key fails SC-08 by design** (reasoned, not a model result). Every re-key copies the whole resource, against SC-08(f)'s "data moved per added server ≤ its share". Its cut-over freezes every partition of the resource at once, against SC-08(b)'s "while others go on". A slot move copies one slot and fences only that slot.
- **So, among these three, slot moves win axis P on the stated threshold.** They are the only option meeting SC-03, SC-04 and SC-08, and they also need the fewest rules of the options that move anything. The fixN + re-key trade, in numbers: 9 more rules (3 more with carried positions), whole-resource copies, a resource-wide freeze, and refused cursors unless positions are carried. CELL's ceiling of 16 writers is not a rule limit: the same 35 rules re-key to any count, and shrink (the `shrink` bound holds with them).
- Part 2 (`pslot`, `split` + merge, lanes + range moves) runs on the same harness and decides axis P overall.

## Method

**One harness, the same world for every option.** [HARNESS.md](HARNESS.md) has the details. In short:
- **Groups** are abstract Raft groups: a committed log, the leader's uncommitted tail, and the tails earlier leaders lost (one may come back until the next commit, as in Raft). A **crash** is a leader crash: the new leader keeps any prefix of the tail. There is no unclean recovery: a committed entry never goes away.
- **Two partitions,** p and q. **Client attempts** carry an id, a partition and a lock token. A copy of any attempt may reach any group at any time, any number of times: stale routes, retries, duplicates and delay, with no client state.
- **One reader** follows p with a cursor, in some bounds.
- **Group-to-group messages are facts in logs.** A group acts on a report by reading the sender's log. With crash-only faults this loses no behaviour (a late, lost or repeated report is a log read late, never or twice), and it keeps the state small. A guard says "committed only" wherever the design waits for a commit, so the mutant that acts on an uncommitted report exists.
- **The event alphabet** QUESTIONS asks for: crash, restart (both one step here: a new leader from the log), partition (a fact never read; liveness is checked from every state), deliver, tick (a timer: cancel, abort, abandon). Plus control (a scale change starts) and read.

**One property module** ([harness/world.py](harness/world.py)), checked on every state, step and calm path (calm: commits, deliveries and reads, with no crash, timer or new scale decision):

| Id | Property | QUESTIONS' words |
|---|---|---|
| P1 | every group that holds a partition open has exactly its history as rows | no acknowledged write lost or doubled |
| P2 | no position names two writes; positions rise along a partition's history | a position never changes meaning |
| P3 | no attempt applied twice; lock tokens never fall; a refused attempt never commits | dedup and fence state survive |
| P4 | what the reader took is a prefix of the history and only grows | a cursor resumes with no gap or overlap |
| P6 | at most one group holds a partition open | one writer per partition |
| L4, L5, L7 | from every state, with no more faults or timers: the reader can catch up; every change under way can end; every attempt can be answered | nothing gets stuck |
| L5b | from every state reached without a give-up timer, every planned grow and shrink can still complete | grow and shrink finish |
| L5g | once a change is given up (cancel, abort, abandon committed), its source can hold the partition again, alone | (added: a give-up must give back) |

**The same bounds for every option** ([harness/bounds.py](harness/bounds.py)). At most 2 leader crashes a run, at most 1 per group (2 in `deep`):

| Bound | Change | Attempts (partition, token) | Reader | Used for |
|---|---|---|---|---|
| `grow` | p's load moves to a second group | w1 (p, 1), w2 (p, 2) | no | sweep |
| `shrink` | p's load comes back to the first group | w1 (p, 1), w2 (p, 2) | no | sweep |
| `both` | grow | w1 (p, 1), w3 (q, 1) | no | sweep |
| `read` | grow | w1 (p, 1), w2 (p, 1) | yes | sweep |
| `deep` | grow, 2 crashes in one group allowed | w1 (p, 1), w2 (p, 2) | no | sweep |
| `twice` | grow, then shrink back; no crash | w1 (p, 1) | yes | sweep |
| `twice1` | grow, then shrink back; 1 crash | w1 (p, 1) | no | verify only (1.3 million states for re-key) |

**Rules counted by ablation, mutants made by script** ([harness/runner.py](harness/runner.py)), as REQUIREMENTS DEV-10 says. Each option is written in a small rule language ([harness/dsl.py](harness/dsl.py)): an action is guard conjuncts and state updates, one field per update. Then:
1. The model as designed must hold everything on every sweep bound.
2. Each rule is dropped alone. It is necessary if some bound then fails.
3. The rules found unnecessary are dropped one by one (greedy, in model-text order), each kept dropped only if everything still holds.
4. A final pass drops each remaining rule once more; any that is now unnecessary is dropped greedily, and the pass repeats until dropping any one rule left breaks a property (1-minimal). Then the smallest model runs on the verify bound (`twice1`); a failure there would put rules back (none was needed).
5. Mutants of the smallest model: drop each guard, drop each update, flip each `<`/`<=`/`>`/`>=`, swap each pair of updates in one action. A mutant no bound catches is **equivalent** if its state graph is the same as the model's on every bound, else it **survived**.
6. Variants of the procedure, each saved under its own name:
   - **`+giveup`** pins an option's give-up steps (never dropped), to price a working give-up path. **`slot+abort`** pins only B's abort, to price a give-up with one decider.
   - A **warm start** begins from a sibling's dropped set, used only if every bound holds with it; steps 2 to 5 then run as usual, so the result is still 1-minimal. `rekey-carry` starts from `rekey`'s result.
   - **Other greedy orders** (finding 5): `rekey-alt` and `rekey-carry-alt` keep one guard in place of its twin; `slot-rev`, `rekey-rev` and `rekey-carry-rev` run greedy in reverse model-text order; `rekey+giveup-alt` drops the bulk-copy path as a whole.
7. A run stops at 1.5 million states. If it found no counterexample by then, the result is `LIMIT` (undecided): the rule stays and is marked undecided, a `LIMIT` on the verify bound puts nothing back, and a mutant stopped there is never counted as caught. **No core set keeps an undecided rule**: every `LIMIT` in pass 1 was settled in the final pass, where the model is smaller. The give-up sets do keep some, because a give-up path makes the model 30 to 260 times bigger; a give-up count is then a range.
8. A log never holds the same entry twice (an exact repeat is ignored), so a guard that only stops an exact repeat is not counted as a rule. That holds for every option.

Every count below is **model-checked here**, from the files in [results/](results). Claims marked **reasoned** are not model results.

**Box and versions.** Linux 6.18 (Firecracker VM), 4 vCPU, 15 GB; Python 3.13.17, standard library only ([results/machine.txt](results/machine.txt)). Model checks ran under `$SP/bin/heavy`, with two worker processes, in pieces of about 20 minutes. Seconds below are from a shared, busy box (other agents' TLC and simulations ran beside them): treat them as rough sizes, not timings.

**Reproduce.** `./run.sh` (all options, then [results/summary.md](results/summary.md)), or `./run.sh slot` for one option. `FRESH=1` ignores the checkpoint. The re-key alternative: `python3 harness/cli.py --option rekey --ablate --warm-from rekey --warm-keep freeze.rkcom --warm-drop freeze.cutcom --warm-drop cut.append --tag rekey-alt`. One run: `python3 harness/cli.py --option slot --bound grow --drop final.outs`. run.sh runs exactly what is reported: each core, slot's and re-key's `+giveup`, the re-key alternative, and `rekey-carry` warm-started from re-key's result.

## Results

The full tables, every rule with what breaks without it and the shortest trace, are in [results/summary.md](results/summary.md). The raw results are `results/<option>-ablation.json`. The per-option READMEs are [options/fixN](options/fixN/README.md), [options/slot](options/slot/README.md) and [options/rekey](options/rekey/README.md).

### What each property needs, beyond fixN

Each cell lists the rules of the smallest set whose removal breaks that property (the property named is the one the shortest counterexample breaks).

| Property | slot moves (13) | `rekey` (22) | `rekey-carry` (16) |
|---|---|---|---|
| P6, one writer | A takes no write once its fence is in its log (`write.nofence`); B takes `END(N)` only from a committed fence (`final.fencom`) | a new generation writes only after its flip commits (`write.live`); an old cell takes no write once frozen (`write.nofrz`); the final copy covers a committed freeze (`final.frzcom`); the flip waits for committed final copies (`flip.fincom`) | as `rekey` |
| P1, no write lost or extra | carry the rows (`final.recs`); take `END(N)` once (`final.once`); export only a slot you hold (`export.open`) | carry the rows (`final.rows`); one re-key at a time (`start.prev`); copy from the current generation (`start.src`) | as `rekey` |
| P3, **dedup transfer** | carry the outcomes (`final.outs`) | the same (`final.outs`) | the same |
| P3, **fence transfer** | carry the highest token (`final.tok`) | the same (`final.tok`) | the same |
| P2, positions | carry the sequence (`final.seq`) | nothing: positions name their generation and cell, so they never collide | nothing |
| P4, cursors (**lineage / cursor refusal**) | nothing: records travel with their `(slot, seq)` | **cursor refusal**, 6 rules: refuse a cursor of another generation (`read.gen`); restart from a snapshot of a newer, flipped cell that holds the partition (`restart.route`, `.newer`, `.live`, `.take`, `.cursor`) | nothing: records travel with their positions, which compare across generations |
| L5b and L7, the change happens | `exporting`, the fence, the final copy and its `END(N)` marker, `open` (5 appends) | `rk`, the cut-over, the freeze, the final copy and its `fin` marker, the flip (6 appends), plus "freeze only for a committed catalog decision" (`freeze.cutcom`; without it an old cell can freeze for a re-key the catalog then loses, and stay frozen) | as `rekey` |

**The state each option adds** (log entry kinds in the smallest model): fixN none; slot moves 4 (`exp`, `fen`, `cp`, `open`); `rekey` 5 (`rk`, `cut`, `frz`, `cp`, `flip`), or 4 without `cut` in the other greedy order (`rekey-alt`).

### The give-up path

A move or re-key may be given up: slot's A cancels before its fence, or B aborts after it; re-key's catalog abandons before the flip. **Under crash-only faults no property needs a give-up at all**: a group always gets a new leader, so every move can finish. The core counts above have no give-up path. To price one that works, the give-up steps are pinned (never dropped), and property L5g asks that a given-up change hands the partition back to its source.

| Option | Core | Give-up steps pinned | Rules the give-up needs (each with a counterexample) | Undecided at the state limit (kept) | **With a working give-up** | States, `shrink` / `deep` |
|---|---|---|---|---|---|---|
| slot moves, two deciders (`slot+giveup`) | 26 | 3: A's `cancel`, B's `abort`, B's `importing` (what an abort names) | 8 | 2 | **37 to 39** | 178,515 / 1,105,399 |
| slot moves, one decider (`slot+abort`) | 26 | 2: B's `abort` and `importing` | {SLOT_ABORT_NEED} | {SLOT_ABORT_UND} | **{SLOT_ABORT}** | {SLOT_ABORT_ST} |
| `rekey` (`rekey+giveup-alt`) | 35 | 1: the catalog's `abandon` | 4 | 1 | **40 to 41** | 597,624 / 89,539 |
| `rekey-carry` (`rekey-carry+giveup`) | 29 | 1 | {CARRY_GU_NEED} | {CARRY_GU_UND} | **{CARRY_GU}** | {CARRY_GU_ST} |

What a give-up needs is the same idea in every option, the two halves of a two-phase commit:
- **Give up or finish, never both.** Each decider refuses to finish once its give-up is in its log, and refuses to give up once its finish is. Slot moves have **two deciders** (A may cancel before its fence; B may abort after it), so they write this twice (4 rules: `cancel.nofence`, `fence.nocancel`, `abort.noopen`, `open.noabort`) and B must clean up after A's cancel (`drop.append`). Re-key has **one decider**, the catalog (2 rules: `flip.noab`, `abandon.noflip`).
- **Hand back only on a committed give-up.** The source reopens only once the give-up has committed (`unfence.abcom`, `thaw.abcom`), with an entry that says so (`unfence.append`, `thaw.append`). Slot moves also check that the abort names a move A fenced (`unfence.fen`): a move named by a log position can be lost in a crash and a later move take its place. Re-key's generations never repeat, so it needs no such check.
- The first `rekey+giveup` run (greedy in text order) kept 45 rules with 6 undecided: it met the bulk copy before the cut-over's guard and could not settle either. Dropping the bulk-copy path as a whole settled 5 of the 6 ([options/rekey](options/rekey/README.md)).
- **A give-up path makes the model 30 to 260 times bigger** (slot `deep`: 5,036 states without, 1,105,399 with). Each full sweep still finishes in minutes, but every `twice1` verify of re-key with a give-up path passed 1.5 million states undecided, so re-key's give-up was checked on the six sweep bounds only.

### Mutants

Mutants were made by script from each smallest model, as DEV-10 (d) says: drop each guard, drop each update, flip each `<`, `<=`, `>`, `>=`, and swap each pair of updates in one action.

| Option | Mutants | Caught | Equivalent (the same state graph on every bound) | Survived | Caught, of the non-equivalent |
|---|---|---|---|---|---|
| fixN | 18 | 17 | 1 | 0 | 100% |
| slot moves | 46 | 35 | 11 | 0 | 100% |
| `rekey` | 53 | 44 | 8 | 1 | 98% |
| `rekey-carry` | 45 | 38 | 7 | 0 | 100% |

- Every dropped guard and update is caught, by construction: the set is 1-minimal.
- Every equivalent mutant swaps two updates that write different fields of one entry. Their order cannot matter.
- The one survivor flips re-key's `restart.newer` from `>` to `>=`. Then a reader may take a snapshot from its own generation as well. That is wasteful but correct, so no property can catch it.
- Counted as DEV-03 counts (the spikes reported 16 of 18 and 19 of 22, equivalents included): 94%, 76%, 83% and 84%. All are well above 85% once the equivalent swaps are set aside.

### States and seconds

| Option | States as written: grow, shrink, both, read, deep, twice | Smallest model, same bounds, then `twice1` | Seconds, the sweep as written |
|---|---|---|---|
| fixN | 28, 28, 41, 61, 58, 4 | the same; 6 | under 1 |
| slot moves | 22,797; 22,797; 39,409; 62,653; 53,644; 1,318 | 1,086; 1,086; 2,262; 2,625; 5,036; 154; 487 | 78 |
| `rekey` | 67,182; 312,298; 94,799; 224,480; 91,722; 236,088 | 1,443; 4,417; 1,764; 3,539; 2,270; 463; 1,147 | 293 |
| `rekey-carry` | 67,182; 312,298; 94,799; 223,737; 91,722; 221,305 | 1,443; 4,417; 1,764; 3,218; 2,270; 259; 1,147 | 336 |

Seconds are wall time on a box shared with other agents' jobs (load 2 to 14), with two worker processes: rough sizes only. As written, re-key's state space is 1.7 to 180 times slot's at the same bound. Its two-change bound with one crash (`twice1`) was about 1.3 million states (134 s, measured while sizing the bounds), too big to sweep. Both smallest models stay small. Model lines (code only, the model as written): fixN 79, slot 363, `rekey` and `rekey-carry` 369 (one file). The harness is about 1,050 lines.

## Findings that could change a candidate

1. **The slot move is smaller than the draft describes.** Under crash-only faults its necessary core is 13 rules beyond fixN (above). DESIGN-V5 §4.2 also has B's `importing`, the bulk copy and ready report, N in the fence, the slot table in `#meta`, incarnations and epochs. None of these is needed by any E-17 property. The table, incarnations and epochs are needed under unclean recovery (slot_move.py, fixes 2 to 5), which this harness does not model. The bulk copy and the ready report only shorten the unwritable window, so they are performance rules (SC-08(b)), and the model cannot judge them. For DEV-01 and DEV-03 this means the move should be specified as two layers: a core whose safety is model-checked, and a performance layer checked against the core's properties. *Moves: MIN family up on DEV-01 and DEV-03.*
2. **Re-key's broken cursors are optional.** Carrying each record's original position in the copy keeps old cursors working, and it costs no rule: `rekey-carry` drops the 6 cursor-refusal rules. The price is data: the copy carries the records (or their segment names), not just the rows, as slot moves already do. CELL's "cursors break" (SPACE §4.2) should be restated. *Moves: CELL up on P-07 and SC-08(d), down nowhere.*
3. **Re-key shrinks with the same rules.** The `shrink` bound (two cells into one) holds with the same 35 rules. CELL's "never shrinks" is not a rule limit. What re-key cannot meet is SC-08(f) and SC-08(b) (whole-resource copy, resource-wide freeze), and that holds for growing and shrinking alike.
4. **Giving up is where the slot move's extra rules live.** The core move needs no give-up path. Pricing one that works: GIVEUP_FINDING
5. **1-minimal is not minimum, and the greedy order matters.** Re-key's set depends on which of two equivalent guards greedy keeps: `freeze.rkcom` or `freeze.cutcom` ("freeze only for a committed catalog decision"). Keeping `rkcom` makes the cut-over entry unnecessary too: `rekey-alt` keeps **34** rules (21 beyond fixN) and `rekey-carry-alt` **28** (15 beyond fixN), each 1-minimal (every rule necessary alone), with mutants 43 of 52 and 37 of 44 caught (8 and 7 equivalent swaps; 1 and 0 survivors). Rule counts from one ablation can differ by 1 or 2 with the order. DEV-10's judging rule treats a difference under 2 as a tie, which fits. Part 2 and the re-run agent should try the obvious alternative orders too.
6. **Re-key is harder to check.** As written, its state spaces are 1.7 to 180 times slot's at the same bounds, because every re-key copies every partition into new groups. Its two-change bound with one crash was about 1.3 million states, against a few thousand for slots. DEV-03 still holds (every sweep run here finished in minutes), but at larger bounds re-key reaches the 1-hour limit first.
7. **Four modelling traps, now written into [HARNESS.md](HARNESS.md).** Each one first made a result wrong, and the ablation itself showed it:
   - **A trigger hidden in the parameters.** The fence enumerated B's copies, so "fence on B's ready report" could not be ablated, and the bulk copy looked necessary.
   - **A move's name checked only by position.** Stale names could then act.
   - **A guard that only stops an exact repeat.** It is not a rule; without the harness's "no exact repeat" rule, a timer repeated an entry until the run blew up.
   - **A liveness property that a change which never starts can satisfy.** L5 is now joined by L5b (the change completes) and L5g (a give-up hands the partition back).

## Requirements: which options can meet SC-03, SC-04 and SC-08

| Requirement | fixN | fixN + re-key | slot moves |
|---|---|---|---|
| SC-03, scale writes up, no count to choose | **fails**: N is chosen up front and is the ceiling (by definition) | can re-key to any count (model: the `grow` bound holds); the count is chosen per re-key | grows to the slot count, the ceiling being E-18's effective number (model: `grow` holds) |
| SC-04, scale down | **fails**: groups never go away | can re-key down (model: `shrink` holds), copying the whole resource each time | the same move empties a group (model: `shrink` holds) |
| SC-08(a), no acknowledged write lost or doubled | holds (P1, P3) | holds (P1, P3) | holds (P1, P3) |
| SC-08(b), a partition unwritable ≤ 10 ms per move **while others go on** | no moves | **fails by design** (reasoned): the cut-over freezes every partition of the resource until the flip commits | one slot is fenced; the rest of the group writes on (the window is E-13's) |
| SC-08(d), no cursor, version or token changes meaning | holds | holds (P2, P3, P4); old cursors are refused (`rekey`), or continue (`rekey-carry`) | holds (P2, P3, P4) |
| SC-08(e), no human step | holds | holds in the model (no step needs a person) | holds in the model |
| SC-08(f), data moved per added server ≤ its share | no data moves | **fails by design** (reasoned): every re-key copies the whole resource | one slot is copied once |

"Holds" here means model-checked at the bounds above, with crash-only faults. The "fails by design" rows are structural arguments (judging rule 1 asks for a second agent to confirm them in writing), not model results. SC-08(b)'s 10 ms and SC-08(f)'s pacing are timing questions for E-13 and the build.

## What the model leaves out

- **Unclean recovery** (a committed log cut back). The harness keeps no message set: a report is a fact in the sender's log, which is sound only while a committed entry never goes away. Under unclean recovery every option needs more rules. slot_move.py found five for slot moves. Re-key's catalog and generations would need their own, and they are not counted here.
- **Groups that die for good.** A crashed leader is always replaced. So no move ever has to be given up, which is why the give-up paths are priced separately. It also means a give-up decided by B alone (`slot+abort`) looks safe here because B always comes back; in a real cluster a B that has lost its majority for good cannot abort, so the source, or `#meta`, must be able to decide too (reasoned). Re-key's decider is the catalog, which is `#meta` in fero.
- **Exact give-up counts.** A few give-up rules stay undecided at 1.5 million states, so the give-up counts are ranges, and the two-change-with-a-crash bound (`twice1`) of re-key with a give-up path is undecided (no counterexample up to the limit). The core counts have no undecided rule.
- **Membership, elections, leases and clocks.** A group is an abstract Raft group (E-14 checks Raft). Timers are free choices, and liveness forbids them.
- **Routing.** A client's copy may reach any group at any time (any stale route), so routing tables, `moved` answers and the `#meta` slot table play no part.
- **The windows.** How long a partition is unwritable, and how much is copied, are not modelled (E-13, E-18). Rules that only shorten the window (bulk copy, ready report, cut-over) are marked `perf`.
- **Size.** Two partitions, one or two slots per resource, at most two scale changes, three groups (four cells for re-key), two crashes a run, two writes, one reader. Bigger bounds may need more rules. A third group would test "one move of a slot at a time" (`export.one`), which no bound here needs.
- **Rules that are not guards or updates.** The value an update computes (for example, N taken from the log's end, not its commit) is not mutated by DEV-10's operators, as in the spikes.
- **The tie-break between equal guards** (finding 5).

## Verdict

VERDICT_TEXT
