# E-17: how many rules each way of mapping partitions onto groups needs

**Question (Q-17).** Measured, not guessed: how complex is each way of mapping partitions onto groups? The options ([QUESTIONS.md](../../QUESTIONS.md) E-17; SPACE axis P): a fixed group count (`fixN`); `fixN` + re-key (CELL); slot moves (MIN, DRAFT and every slot row); `pslot`, slot moves in groups shared by a project's resources (MIN-P); split + merge (SPLIT); lanes + range moves (LANE).

**Threshold** (QUESTIONS Q-17). Among the options that meet SC-03 (writes scale up), SC-04 (scale down) and SC-08 (no worry during a change), the fewest necessary rules wins axis P. If `fixN` + re-key is smaller than slot moves, the verdict states the trade in numbers.

**Three parts, one harness.**
- [Part 1](PART1.md) built the shared harness ([HARNESS.md](HARNESS.md)) and checked `fixN`, re-key and slot moves.
- [Part 2](../E17b-partitioning-part2/README.md) added `pslot`, split + merge and lanes + range moves on the same harness.
- [Part 3](../E17c-partitioning-rerun/README.md), a second agent, re-ran every ablation from scratch and hunted for rules the harness misses or counts wrongly. This file is the E-17 verdict, written by part 3.

**Words.** A *rule* is one guard conjunct or one state update in a model action. It counts only if removing it lets the checker find a counterexample (REQUIREMENTS DEV-10). *Ablation* removes rules one by one to find a *smallest set*, where removing any one rule breaks a property (1-minimal). A *give-up path* is how a change is abandoned half-way (an abort). *Lineage* is the chain a reader follows from a partition's old group to its new one. *Dedup transfer* and *fence transfer* carry the "already applied" table and the highest lock token to the new group. *Cursor refusal* turns away a reader's old position and restarts it from a snapshot. A *once guard* stops a step from writing an entry its log already holds, which a real log needs because a step can run twice (a retry, a redelivery).

## The answer, first

All counts are **model-checked here**, on one shared harness, at the same bounds, with crash-only faults, as REQUIREMENTS DEV-10 counts rules. Claims marked **reasoned** are not model results.

- **Slot moves win axis P.** Among the options that meet SC-03, SC-04 and SC-08, they need the fewest rules: **26** on the shared bounds, **28** once the move is also safe in a real log (where a step can run twice) and on bigger bounds (a third group, a reader across a move and back). Split + merge needs 33 and 37 on the same footing.
- **The counts are reproducible.** A second agent re-ran 20 of the ablations from scratch, with fresh caches: the same smallest sets, the same verdict for every rule, the same 517 mutants row by row, the same state sets. The five one-decider give-up prices were checked fresh: all five hold with the same state sets, and 179 of 179 rules in them fail (or stop at the state limit) exactly as before.
- **`pslot` (MIN-P) costs no more rules than slot moves.** Part 2 counted 4 more (30): rules that make each move entry name its resource. A probe (`slotkey`) shows slot's model needs the same 4 when its slot key is written the same way: the 4 rules name the slot key in any slot move, and slot's model had built the key into each entry where ablation never asks. On the same footing both are 26 (28 in a real log).
- **Re-key fails SC-08, now model-checked.** In every re-key set, a write to a partition that never moves must wait for the re-key (SC-08(b), "while others go on"), and that partition's rows are copied to the new generation (SC-08(f), "data moved ≤ its share"). Parts 1 and 2 had argued this in words. Every other option passes both checks.
- **The trade with re-key, in numbers.** CELL as written (old cursors refused): 35 rules, 9 more than slot moves; with carried positions 29, 3 more. In a real log at the bigger bounds: 36 to 38 and 30 to 32, against 28. With a working one-decider give-up: 40 to 41 and 34 to 35, against 33 to 34 (a tie for `rekey-carry` under DEV-10's rule that a difference under 2 is a tie). Its ceiling of 16 writers is not a rule limit: the same rules re-key to any count, and shrink. What re-key cannot meet is SC-08(b) and (f).
- **Lanes need 2 more rules than slot moves** (28; 26 when the copy carries the records) **and fail SC-03 and SC-04 by design** (reasoned): the lane count is fixed per project and never shrinks.
- **The slot move can be specified smaller.** Written the way a split is (the fence is the decision, the final copy opens the slot), the move needs 22 rules on the same footing (24 counted with its 2 naming rules), 23 in a real log, 28 with a give-up path.

## The table of options

### Rules

"Same footing" counts every option without rules that only name a move entry's key, as slot's, lanes', split's and re-key's models are written (see `pslot`). "Real log, bigger bounds" is part 3's C count: the smallest set with every rule put back that a step taken twice (R) or the bigger bounds (B) need, checked on every bound at once (the 7 shared ones and up to 6 bigger ones), with every rule put back needed again (two re-key once guards stay undecided, hence its ranges) ([../E17c-partitioning-rerun](../E17c-partitioning-rerun/README.md), section 5).

| Option (rows) | Rules as written | **Necessary**, shared bounds | Beyond fixN | Other greedy order | **Real log, bigger bounds** | With a working one-decider give-up | Meets SC-03 / SC-04 / SC-08 |
|---|---|---|---|---|---|---|---|
| fixN (the floor of every row) | 14 | **13** | 0 | - | 13 | nothing to give up | no / no / no change to check |
| **slot moves** (MIN, DRAFT, every slot row) | 69 | **26** | 13 | 26 (N in the fence instead of the carried sequence) | **28** | 33 to 34 | yes / yes / yes |
| `pslot` (MIN-P), as counted | 80 | **30** | 17 | 30 | 32 | 38 to 40 (part 2: 39 to 40, as its `export.res` is needed in the core) | yes / yes / yes |
| `pslot`, same footing | - | **26** | 13 | 26 | 28 | 33 to 34 (reasoned: less its 6 names) | as above |
| split + merge (SPLIT) | 47 | **33** | 20 | 33 | **37** | 39 on the shared bounds (40 on `readback`) | yes / only with merges / yes |
| lanes + range moves (LANE), records stay | 68 | **28** | 15 | 28 | 30 | 36 to 37 | **no / no** (by design, reasoned) / yes |
| lanes, records carried | 67 | **26** | 13 | - | 28 | - | as lanes |
| fixN + re-key (CELL as written: old cursors refused) | 57 | **35** | 22 | 34 to 35 | 36 to 38 | 40 to 41 | yes / yes / **no**: (b) and (f) fail (model-checked) |
| fixN + re-key, positions carried | 51 | **29** | 16 | 28 to 29 | 30 to 32 | 34 to 35 | yes / yes / **no** |
| probe: the slot move fused (fence = decision, copy = open) | 35 | **24**; 22 on the same footing | 11 | 24 | 25; 23 same footing | 31; 28 same footing | as slot moves |

A range "a to b" counts rules still undecided at the state limit (1.5 million states), which are kept. The give-up prices are those of parts 1 and 2; part 3 checked each set fresh (it holds, with the same states; every rule in it is needed, with the same first failure), but did not re-derive it.

### Size and checking

From part 3's re-run ([../E17c-partitioning-rerun/results/table.md](../E17c-partitioning-rerun/results/table.md)). The harness state is the same for every option (per group: committed log, uncommitted tail, lost tails, crash count; the reader's cursor and what it took; the ghost history); an option adds only kinds of log entry and the shape of its cursor. Seconds are on a shared box: sizes, not timings.

| Option | Model lines | State an option adds: entry kinds (fields) | Cursor parts | States as written, 6 sweep bounds | States, smallest model, 6 bounds; `twice1` | Seconds, one sweep as written | Mutants caught (equivalent; survived) |
|---|---|---|---|---|---|---|---|
| fixN | 79 | none | 2 (group, index) | 220 | 220; 6 | under 1 | 17 of 18 (1; 0) |
| slot moves | 363 | 4: `exp` (2 fields), `fen` (3), `cp` (8), `open` (3) | 2 (slot, sequence) | 202,618 | 12,249; 487 | 51 | 35 of 46 (11; 0) |
| `pslot` | 402 (with the probe's loader) | 4, as slot, each naming its resource | 3 (resource, slot, sequence) | 202,618 | 12,249; 487 | 49 | 43 of 59 (16; 0) |
| split + merge | 294 | 5: `spl` (3), `init` (7), `mrg` (2), `sub` (2), `mgd` (7); lineage bases kept for ever | 3 (generation, group, index) | 3,473 | 2,244; 209 | 1 | 46 of 59 (13; 0) |
| lanes + range moves | 368 (with `lanes-carry`) | 4: `exp` (2), `fen` (3), `cp` (8), `open` (2); `END(N)` bases kept for ever | 3 (epoch, lane, index) | 202,618 | 12,298; 660 | 37 | 39 of 50 (11; 0) |
| lanes, records carried | 368 | 4, as lanes | 3 | 202,618 | 12,249; 487 | 28 | 35 of 46 (11; 0) |
| re-key (`rekey`) | 369 (with `rekey-carry`) | 5: `rk` (2), `cut` (1), `frz` (1), `cp` (7), `flip` (1) | 3 (generation, cell, index) | 1,026,569 | 13,896; 1,147 | 101 | 44 of 53 (8; 1) |
| re-key, positions carried | 369 | 5, as `rekey` | 3 | 1,011,043 | 13,371; 1,147 | 140 | 38 of 45 (7; 0) |
| probe: fused slot move | 235 | 2: `fen` (3), `cp` (6) | 3 | 15,603 | 1,982; 115 | 3 | 34 of 45 (11; 0) |

Every mutant that is not caught is either equivalent (it swaps two updates that write different fields of one entry, so the state graph is identical) or, once, a harmless widening (re-key's `restart.newer` from `>` to `>=` lets a reader restart from its own generation: wasteful, correct). Of the non-equivalent mutants, 100% are caught in every option but re-key (98%). Every full sweep finishes in under 3 minutes, far inside DEV-03's hour.

### The extra machinery each property needs

Rules beyond fixN, by the property whose counterexample shows they are needed (part 1's and part 2's tables, confirmed rule for rule by the re-run; once guards and the bigger bounds from part 3).

| Property | slot moves | `pslot` | split + merge | lanes + range moves | re-key (`rekey` / `rekey-carry`) |
|---|---|---|---|---|---|
| P6, one writer | 2: no write once the fence is in the log; copy only from a committed fence | as slot | 6: the same pair for the split and for the merge; freeze only a partition you hold; **split only a partition you hold** (third group) | as slot | 4: write only after the flip commits; no write once frozen; copy covers a committed freeze; flip waits for committed copies |
| P1, no write lost or extra | 3: carry the rows; take `END(N)` once; export only a slot you hold | as slot | 2: carry the rows, twice | as slot | 3: carry the rows; one re-key at a time; copy from the current generation |
| P3, **dedup transfer** | 1 | 1 | 2 (split and merge) | 1 | 1 |
| P3, **fence transfer** | 1 | 1 | 2 | 1 | 1 |
| P2, positions keep meaning | 1: carry the sequence (or N in the fence) | 1 | 1: the merge gives a new generation | 1: carry the range's epoch | 0: positions name their generation |
| P4, cursors: **lineage** | 0: records travel with `(slot, seq)` | 0 | 2 on the shared bounds, 3 with a reader across a merge (`read.lin`, `init.base`, `merged.base`) | 2 (`read.lin`, `fence.N`); 0 when records travel | 0 |
| P4, cursors: **cursor refusal** | 0 | 0 | 0 | 0 | 6 / 0: refuse a cursor of another generation and restart it from a snapshot; carried positions remove all 6 |
| Naming the move's key | (built in; 4 if counted) | 4 | (built in) | (built in) | (built in) |
| Progress (the change happens) | 5 appends | 5 | 5 appends + "freeze only for a committed merge" | 5 | 6 appends + "freeze only for a committed cut-over" |
| **Once guards** (a real log) | 2: fence once, open once | 2 | 2: init once, merged once | 2 | 1 to 3: final copy once; freeze once and flip once undecided |

## Who meets SC-03, SC-04 and SC-08

| Requirement | fixN | re-key (CELL) | slot moves, `pslot` | split + merge | lanes |
|---|---|---|---|---|---|
| SC-03, writes scale up, no count to choose | **fails**: N is the ceiling (by definition) | re-keys to any count (model: `grow` holds); CELL's 16 is a choice, not a rule limit | up to E-18's effective number (model: `grow` holds) | no fixed ceiling (model: `grow` holds) | **fails by design** (reasoned): the project's lane count (64) caps every resource |
| SC-04, scale down | **fails** | re-keys down (model: `shrink` holds) | the same move (model: `shrink` holds) | only with merges (model: `shrink` holds) | **fails by design** (reasoned): lane groups never go away |
| SC-08(a), no acknowledged write lost or doubled | holds | holds (P1, P3) | holds | holds | holds |
| SC-08(b), unwritable only during its own move, **while others go on** | no moves | **fails (model-checked, L8)**: a write to a partition that never moves waits for the re-key | holds (L8) | holds (L8); a merge moves, so freezes, every partition of the group it removes | holds (L8) |
| SC-08(d), no cursor, version or token changes meaning | holds | holds (P2, P3, P4); old cursors refused, or kept with carried positions | holds | holds, with lineage and generations | holds, with lineage and the range's epoch |
| SC-08(e), no human step | holds | holds in the model | holds | holds | holds |
| SC-08(f), data moved ≤ its share | nothing moves | **fails (model-checked, F8)**: rows of a partition that never moves are copied | holds (F8): one slot is copied | holds (F8): a split copies nothing | holds (F8) |

"Holds" means model-checked at the bounds here, with crash-only faults. SC-08(b)'s 10 ms and SC-08(f)'s "≤ its share" in bytes are E-13's and E-18's: L8 and F8 check only that a change touches nothing it does not move.

## What part 3 changed

Part 3 re-ran parts 1 and 2 and hunted for missed and extra rules ([../E17c-partitioning-rerun/README.md](../E17c-partitioning-rerun/README.md)). No count of parts 1 and 2 was wrong. What changes is what the counts mean:
1. **`pslot` = slot moves on rules** (probe `slotkey`): part 2's finding 1 ("4 more rules") and its move "MIN-P down on DEV-01 by 4" are withdrawn. The 4 rules exist in every slot move; only `pslot`'s model counted them.
2. **Re-key's SC-08(b) and (f) failures are model-checked** (L8 and F8 fail in every re-key set, as written and smallest), not only reasoned.
3. **Split + merge needs 2 more rules than the shared sweep shows**: the merge's lineage base on `readback` (part 2's) and "split only a partition you hold" once a third group exists (new: two groups hold the partition in 5 steps without it).
4. **Every option needs once guards in a real log**, which the shared harness never counts (it ignores an exact repeat). Slot, `pslot` and lanes need 2 ("fence a move once", which part 2 found on `readback`, and "open a move once"); split + merge 2; re-key 1 to 3; the fused move 1. They add about the same to every option, so the order does not change.
5. **"Take the final copy once" is a rule of when the model takes the copy** (probe `slotprobe-atfence`: 25 when the copy is taken at the fence), as part 2 found for lanes; a real log puts it back. The filter in slot's `open` hid no rule (probe `slotprobe-trig`: still 26).

## Findings that could change a candidate

1. **Slot moves win axis P, and stay the smallest option on every footing** (shared bounds 26; real log and bigger bounds 28; with a one-decider give-up 33 to 34). Split + merge is 7 to 9 rules bigger and two protocols; re-key 2 to 10 bigger and fails SC-08(b) and (f); lanes 2 bigger and fail SC-03 and SC-04. *Moves: MIN, MIN-TS, RUST, SRV, LEAN, DRAFT and every slot row up on DEV-01 and DEV-03.*
2. **MIN-P ties MIN on axis P.** Groups shared by a project's resources add no rule to the move. What `pslot` buys (SC-13, many small resources in few groups) and costs (equal `copies` and durability per group, about 2 placement rules, reasoned by part 2) is axis G's question, with E-36. *Moves: MIN-P up on DEV-01 (part 2's 4-rule penalty withdrawn).*
3. **CELL's re-key is checked to fail SC-08(b) and (f)**, and it is 2 to 10 rules bigger than slot moves on every footing but the give-up price, where `rekey-carry` ties. Its "16 writers", "cursors break" and "never shrinks" are not rule limits (part 1). *Moves: CELL down on SC-08(b), SC-08(f) (now model-checked) and DEV-01.*
4. **SPLIT is 37 against 28 on the same footing**, because a split cannot shrink and its merge is a second protocol with its own carry, generation and lineage, and a split must check it holds what it splits. *Moves: SPLIT down on DEV-01 and DEV-02.*
5. **LANE's range move is the slot move plus 2 lineage rules** (0 if records travel); lanes lose on SC-03 and SC-04, not on rules. *Moves: LANE down on SC-03 and SC-04 (by design, reasoned).*
6. **Write the slot move's spec with its once guards** ("a move is fenced once, opened once"), and consider the fused shape: a 22-rule core (fence = decision, copy = open) with the announcement, bulk copy and ready report as a performance layer checked against the core's properties (parts 1 and 2, reasoned from the probe). *Moves: every slot row up on DEV-03 if DESIGN-V5 §4.2 is restated this way.*

## What the model leaves out

- **Unclean recovery** (a committed entry cut back). Every option would need more rules; slot_move.py and E-15 found five for slot moves. Re-key's catalog and split's lineage would need their own; none are counted here.
- **Groups that die for good.** A crashed leader is always replaced, so no change ever has to be given up; give-up paths are priced separately, and a one-decider give-up decided by B alone looks safe only because B always comes back (E-16 asks who decides then).
- **Membership, elections, leases, clocks and routing tables.** A group is an abstract Raft group (E-14 checks Raft); any client copy may reach any group (any stale route).
- **The windows.** How long a partition is unwritable and how much is copied are E-13's and E-18's; rules that only shorten the window (bulk copy, ready report, cut-over) are counted as not needed.
- **Size.** Two partitions, up to three groups, two writes, one reader, two changes. Part 3's bigger bounds found one new rule (`split.open`, for split + merge) and none for the slot family beyond part 2's "fence a move once"; a rule only a fourth group, a third partition or two controllers at once would need would not show.
- **1-minimal is not minimum.** Two greedy orders, warm-start twins and probes were run; counts can still differ by 1 or 2 with the order, which DEV-10 calls a tie.
- **The give-up prices** were checked, not re-derived, by part 3, and some give-up rules stay undecided at the state limit (the ranges). R and C were not settled for the give-up sets (a step taken twice makes them pass 300,000 states).

## Reproduce

Each part has its own `run.sh`: [run.sh](run.sh) here (part 1: `fixN`, slot, re-key), [../E17b-partitioning-part2/run.sh](../E17b-partitioning-part2/run.sh) (part 2: `pslot`, split + merge, lanes), and [../E17c-partitioning-rerun/run.sh](../E17c-partitioning-rerun/run.sh) (part 3: the re-run from scratch, the give-up checks, the hunt, the probes, and the tables in this file). Python 3.13, standard library only; Linux 6.18, 4 vCPU, 15 GB. One run: `python3 harness/cli.py --option slot --bound grow --drop final.outs`.

## Verdict

**Threshold** (QUESTIONS Q-17): among the options meeting SC-03, SC-04 and SC-08, the fewest necessary rules wins axis P; if `fixN` + re-key is smaller than slot moves, the verdict states the trade in numbers.

- **Who meets them:** slot moves, `pslot` and split + merge (split only with merges). fixN fails SC-03 and SC-04 by definition; lanes fail SC-03 and SC-04 by design (reasoned); re-key fails SC-08(b) and (f) (model-checked).
- **The fewest rules among them: slot moves**, 26 (28 in a real log at bigger bounds), with `pslot` the same on the same footing, and split + merge at 33 (37). The gaps (7 and 9) are well over DEV-10's tie margin of 2.
- **Re-key is not smaller** on any footing (35 or 29 against 26; 36 to 38 or 30 to 32 against 28), except that a re-key with carried positions ties a one-decider slot move on the give-up price (34 to 35 against 33 to 34). The trade: about the same rules at best, for a whole-resource copy and a resource-wide freeze on every change (model-checked), and a model 1.7 to 180 times bigger to check.

Q-17: Slot moves win axis P: among the options that meet SC-03, SC-04 and SC-08 they need the fewest rules, 26 on the shared bounds and 28 once the move is also safe in a real log and at bigger bounds, against 33 and 37 for split + merge, and `pslot` needs exactly as many when its key is counted the same way (part 2's 4 extra rules name the slot key in any slot move); re-key is 2 to 10 rules bigger and fails SC-08(b) and (f), now model-checked (a write to a partition that never moves waits for the re-key, and that partition's rows are copied), tying a one-decider slot move only on the give-up price (34 to 35 against 33 to 34); lanes need 2 more rules and fail SC-03 and SC-04 by design (reasoned); every count reproduced exactly under a second agent (model-checked, crash-only faults). Moves: MIN and every slot row up on DEV-01 and DEV-03; MIN-P up on DEV-01 (it ties MIN on axis P); CELL down on SC-08(b), SC-08(f) and DEV-01; SPLIT down on DEV-01 and DEV-02; LANE down on SC-03 and SC-04.
