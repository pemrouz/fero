# E-17 (part 2): pslot, split + merge, and lanes + range moves, on the shared harness

**Question (Q-17).** Measured, not guessed: how complex is each way of mapping partitions onto groups? [Part 1](../E17-partitioning/README.md) built the shared harness and checked `fixN`, `fixN` + re-key and slot moves. This is part 2. It adds the other three options QUESTIONS.md names, on the **same harness, the same bounds and the same properties**, with nothing in the harness changed:
- **`pslot`** (MIN-P): slot moves where groups belong to the project, so one group holds slots of several resources, and a move splits one resource's slot out of a shared group;
- **`split` + merge** (SPLIT): a group splits under load and merges back when load falls, CockroachDB's way, with lineage for readers;
- **lanes + range moves** (LANE): a fixed number of project lanes, with key ranges moved between them, and per-lane offsets with lineage.

## The answer, first

All counts are **model-checked here**, on part 1's harness and bounds, with crash-only faults, as REQUIREMENTS DEV-10 counts rules: a rule counts only if removing it lets the checker find a counterexample. Slot moves are part 1's numbers, for reference.

| Option | Rules as written | **Necessary** (smallest set) | Beyond fixN's 13 | On the bigger bounds | With a working give-up path | Mutants caught (equivalent; survived) | States as written / smallest, `shrink` |
|---|---|---|---|---|---|---|---|
| slot moves (part 1) | 69 | **26** | 13 | 26; the reverse-order set needs 1 back (27) | 33 to 34 (one decider); 37 to 39 (two, as drafted) | 35 of 46 (11; 0) | 22,797 / 1,086 |
| **`pslot`** (MIN-P) | 80 | **30** | 17: slot's 13 + 4 that name the resource | 30; the reverse-order set needs 1 back (31) | **39 to 40** (one decider): slot's 33 to 34 + 6 names | 43 of 59 (16; 0) | 22,797 / 1,086 |
| **split + merge** (SPLIT) | 47 | **33** | 20: the split 9, the merge 11 | **34**: a reader across a merge needs its lineage base | **39** (one decider: the merging group) | 46 of 59 (13; 0) | 1,616 / 468 |
| **lanes + range moves** (LANE), records stay, lineage | 68 | **28** | 15: slot's 13 + 2 of lineage | **29** in both orders: "fence a move once" comes back | **36 to 37** (one decider): slot's 33 to 34 + 2 lineage + "fence once" | 39 of 50 (11; 0) | 22,797 / 1,086 |
| lanes + range moves, records travel (`lanes-carry`) | 67 | **26** | 13: slot's, rule for rule | 26 | as lanes | 35 of 46 (11; 0) | 22,797 / 1,086 |
| probe: `pslot-fused` (the move shaped like a split) | 35 | **24** | 11: a 9-rule move + 2 naming | 24 | 31 (28 without naming) | 34 of 45 (11; 0) | 1,799 / 234 |

- **`pslot` is slot plus 4 rules, and nothing else.** Every rule slot needs, pslot needs, and the only new ones say which resource a move entry is about: `exporting`, the fence, the final copy and `open` must each name the resource, not only the slot number. Without one, a group that holds slot 0 of two resources fences, copies or opens the wrong one (P6 or L7 in 5 to 8 steps). No new mechanism, but 4 rules: SPACE §2's "0 beyond P `slot`" is right about mechanisms and wrong about rules.
- **Split + merge is two protocols.** The split alone is small: one entry at the parent that is both the decision and the fence, and one `init` at the new group that carries the rows, the dedup outcomes, the highest lock token and the lineage base: 9 rules beyond fixN, fewer than slot's 13. But a split cannot shrink. Merging back is a second protocol (merging, subsumed, merged) that repeats the carry and adds a generation: 11 more. Readers follow lineage across both: 2 rules on the shared bounds, 3 once a reader crosses a merge with records on both sides.
- **Lanes + range moves is the slot move, plus lineage.** With the slot move's protocol, a range move needs exactly slot's rules when the copy carries the records (`lanes-carry`: 26, rule for rule), and 2 more when records stay in the old lane and readers follow lineage, as LANE's per-lane offsets imply (28). The per-lane offset also needs a per-range epoch carried by every move, which takes the place of slot's carried sequence. V5-UNITS was right: "lanes with the count free and the names fixed" is slots. What lanes cost is not rules: a fixed lane count caps writers per project and never shrinks (below).
- **Part of a split's advantage is the shape of its entries, not the option.** The probe `pslot-fused` writes the slot move the way a split is written: A's first entry is the fence (the decision and the fence at once), and B's one entry is the final copy, which also opens the slot. It needs **9 rules beyond fixN for the move**, the same as the split, and 4 fewer than the drafted move's 13. A split is a fused move that copies nothing; a merge is a second fused move the other way. A slot move fused this way would need about 22 rules core and 28 with a give-up path (reasoned from the probe, less its naming rules), against 26 and 33 to 34 as drafted.
- **Who meets SC-03, SC-04 and SC-08:** slot moves, `pslot` and split + merge (the last only with merges, and its merge freezes every partition of the merged group at once, reasoned). Lanes fail SC-03's floor and SC-04 by design (reasoned): the lane count is fixed per project, shared by every resource, and never shrinks.
- **So, on the threshold, slot moves win axis P** with 26 necessary rules, against 30 for `pslot` and 33 to 34 for split + merge (with one-decider give-up paths: 33 to 34, against 39 to 40 and 39). `pslot` is axis G's question (one log per resource's slot set, or per project), and its price is 4 rules, which DEV-10's judging rule does not call a tie (a difference of 2 or more).


## Method

**The harness is part 1's, unchanged** ([../E17-partitioning/HARNESS.md](../E17-partitioning/HARNESS.md)). In short: groups are abstract Raft groups (a committed log, the leader's uncommitted tail, tails earlier leaders lost); a crash is a leader crash that keeps any prefix of the tail; there is no unclean recovery. Two partitions, p and q. Client attempts carry an id, a partition and a lock token, and a copy of any attempt may reach any group at any time, any number of times. One reader follows p in some bounds. A group acts on another's report by reading that group's log. The properties are part 1's (P1 no write lost or extra, P2 positions keep their meaning, P3 dedup and fences survive, P4 cursors resume with no gap or overlap, P6 one writer, and the liveness goals L4, L5, L5b, L5g, L7), on part 1's bounds (`grow`, `shrink`, `both`, `read`, `deep`, `twice`; `twice1` verifies).

**Each option is one file** under [../E17-partitioning/options/](../E17-partitioning/options), written in the harness's rule language: an action is guard conjuncts and state updates, one field per update. Each was written from its source's description first, run on every bound until it held everything, and only then ablated. Their READMEs say what each models and leaves out:
- [options/pslot](../E17-partitioning/options/pslot/README.md) ([model.py](../E17-partitioning/options/pslot/model.py), and the probe [fused.py](../E17-partitioning/options/pslot/fused.py));
- [options/split](../E17-partitioning/options/split/README.md) ([model.py](../E17-partitioning/options/split/model.py));
- [options/lanes](../E17-partitioning/options/lanes/README.md) ([model.py](../E17-partitioning/options/lanes/model.py)).

**Counting, as REQUIREMENTS DEV-10 says, by part 1's runner** ([../E17-partitioning/harness/runner.py](../E17-partitioning/harness/runner.py)): drop each rule alone; drop the unneeded ones greedily in model-text order; a final pass until every rule left is needed alone (1-minimal); verify on `twice1`; then mutants made by script (drop each guard and update, flip each comparison, swap each pair of updates in one action), a mutant no bound catches being **equivalent** if its state graph equals the model's on every bound. Per option, as part 1 did:
- the core ablation with mutants;
- the same with greedy in **reverse** model-text order (`-rev`), since the order can pick a different twin;
- the price of a **working give-up path**: the give-up steps pinned (never dropped), property L5g asking that a given-up change hands the partition back;
- for lanes, the variant whose copy carries records (`lanes-carry`), as part 1's `rekey-carry`.

**Two checks part 1 did not have, kept outside the harness** so the shared counts stay comparable:
- **Three bigger bounds** ([extra.py](extra.py)): `readback` (grow then shrink back with the reader on and two writes, so a reader must cross a change back with records on both sides), `readback1` (the same with one crash) and `bothread` (grow, a write to each partition, the reader on). Every smallest set, part 1's included, runs on them, and where one fails, a search says which single dropped rule, put back, makes every bound hold.
- **A probe of the move's shape** (`pslot-fused`): pslot's move with its entries fused the way a split fuses them (the fence is the decision; the final copy opens B). It asks how much of a split's advantage, if any, is the entry shape rather than the option.

**One harness quirk, worked around, not changed.** `cli.py` applies `--warm-keep` only when some `--warm-drop` is also given. The first give-up runs here met it: their warm starts were refused (a bound failed with the give-up rules dropped), so `split+giveup` and `pslot-fused+abort` ran the full procedure, with no warm start, which is what `run.sh` now asks for them. `pslot+abort` and `lanes+abort` pass one harmless `--warm-drop` (a rule the core already dropped) so their keeps apply, as part 1's `slot+abort` did; every bound held with their warm sets.

**Box and versions.** Linux 6.18 (Firecracker VM), 4 vCPU, 15 GB; Python 3.13.17, standard library only ([results/machine.txt](results/machine.txt)). Every model run went through `$SP/bin/heavy` with two worker processes, in pieces of about 20 minutes, except a few runs of seconds while the models were written (see "What the model leaves out"). Seconds below come from a shared box: rough sizes, not timings.

**Reproduce.** `./run.sh` runs everything in the order reported and writes [results/summary.md](results/summary.md) and [results/extra.txt](results/extra.txt); `./run.sh split` one option; `FRESH=1 ./run.sh split` ignores the checkpoints (a re-run by a second agent). One run: `python3 ../E17-partitioning/harness/cli.py --option split --bound shrink --drop merged.gen`. A bigger bound: `python3 extra.py --option split --minimal split --bound readback --repair`. The re-check of 2026-11-08 (below): `./run.sh recheck`.

## Results

The full tables, every rule with what breaks without it and its shortest trace, are in [results/summary.md](results/summary.md), made by part 1's own report script ([report2.py](report2.py) only picks the options). The raw results are `../E17-partitioning/results/<option>-ablation.json`. The per-option READMEs give each rule's story: [pslot](../E17-partitioning/options/pslot/README.md), [split](../E17-partitioning/options/split/README.md), [lanes](../E17-partitioning/options/lanes/README.md).

### What each property needs, beyond fixN

Each cell lists the rules of the smallest set whose removal breaks that property (the property named is the one the shortest counterexample breaks). Slot's column is part 1's.

| Property | slot moves (13) | `pslot` (17) | split + merge (20; 21 on `readback`) | lanes + range moves (15) |
|---|---|---|---|---|
| P6 / P1, one writer | A takes no write once its fence is in its log; B takes `END(N)` only from a committed fence | as slot | split: A takes no write once its split is in its log; B starts only from a committed split. Merge: A takes no write once subsumed is in its log; B merges only from a committed subsumed; A freezes only a partition its committed log holds | as slot |
| P1, no write lost or extra | carry the rows; take `END(N)` once; export only a slot you hold | as slot | carry the rows, twice (init and merged) | as slot (rows only, no records) |
| P3, **dedup transfer** | carry the outcomes | as slot | carry them twice | as slot |
| P3, **fence transfer** | carry the highest token | as slot | carry it twice | as slot |
| P2, positions | carry the sequence (or N in the fence) | carry the sequence | a merge gives the merged group a new generation (`merged.gen`); a split needs none | carry the range's epoch (`final.ep`) |
| P4, cursors (**lineage**) | nothing: records travel with their `(slot, seq)` | nothing | **lineage**: a record after an init or merged entry is read only once the cursor reached its base (`read.lin`); the init carries the base (`init.base`); on `readback` the merged entry too (`merged.base`) | **lineage**: a record after a move is read only once the cursor reached `END(N)` (`read.lin`); N is the range's last position in A's log (`fence.N`). With records carried (`lanes-carry`): nothing |
| L7 / P6, **naming** | — | `exporting`, the fence, the final copy and `open` name the resource (`export.res`, `fence.res`, `final.res`, `open.res`) | — | — |
| L5b and L7, the change happens | the appends of `exporting`, the fence, the final copy, its `END(N)` marker and `open` (5) | as slot | the appends of split, init, merging, subsumed and merged (5), plus "freeze only for a committed merging" (`subsume.mrgcom`) | as slot |

**State variables.** The harness state is the same for every option (per group its committed log, tail, lost tails and crash count; the reader's cursor and what it took; the ghosts). An option adds only kinds of log entry, their fields and the shape of its cursor. In the smallest models:
- `pslot`: slot's 4 entry kinds (`exp`, `fen`, `cp`, `open`), each with a resource field; cursor `(resource, slot, sequence)`.
- split + merge: 5 entry kinds (`spl`, `init`, `mrg`, `sub`, `mgd`); a generation per group; cursor `(generation, group, index)` plus the lineage bases kept in `init` and `mgd` entries, for ever.
- lanes: slot's 4 entry kinds; an epoch per range; cursor `(epoch, lane, index)` plus the `END(N)` lineage bases kept in the copies, for ever. `lanes-carry`: the same, with the records in the copy and no lineage.
- `pslot-fused`: 2 entry kinds (`fen`, `cp`); cursor as `pslot`.

### The give-up path

As in part 1, no property needs a give-up under crash-only faults (a group always gets a new leader), so the core counts have none. Each give-up path is priced by pinning its first step and letting property L5g ask that a given-up change hands the partition back.

| Option | Core | Pinned | Rules the give-up needs | Undecided (kept) | **With a working give-up** |
|---|---|---|---|---|---|
| slot, one decider (part 1, `slot+abort`) | 26 | 2: B's `abort` and `importing` | 5 | 1 | **33 to 34** |
| `pslot`, one decider (`pslot+abort`) | 30 | 2: B's `abort` and `importing` | 7: slot's 5 + the resource named in `abort` and `unfenced` | 1 (`abort.imp`, as slot); `export.res`, needed in the core, is also undecided here | **39 to 40** |
| split + merge (`split+giveup`) | 33 | 1: B's `merge-abort` | 5 | 0 | **39** |
| lanes, one decider (`lanes+abort`) | 28 | 2: B's `abort` and `importing` | 6: slot's 5 + "fence a move once" (`fence.once`) | 1 (`abort.imp`, as slot) | **36 to 37** |
| `pslot-fused`, one decider (`pslot-fused+abort`) | 24 | 1: B's `abort` | 6 (one of them a name) | 0 | **31** (28 without naming) |

- **`pslot`'s give-up adds 2 more names**: B's `abort` and A's `unfenced` must name the resource (P6 in 10 steps on `shrink` without either), so a give-up path costs `pslot` 6 rules over slot's, not 4. The undecided `export.res` is decided necessary in the core model (L7 in 6 steps); with the give-up path the model is too big to settle it.
- **Lanes' give-up needs "fence a move once" even on the shared bounds:** after B aborts and A reopens, A can fence the same move again with a new N, and the move is stuck (L7 in 12 steps). Slot's `slot+abort` does not need it only because its smallest set has no N in the fence (finding 6).
- **The merge's give-up needs the same five rules as a one-decider slot move**, in the same two halves of a two-phase commit: give up or finish, never both (`merged.noab`, `mabort.nomgd`), and hand back only on a committed give-up, only for a change that froze, with an entry that says so (`unsub.abcom`, `unsub.sub`, `unsub.append`). It needs no `importing` entry: the merge is named by the decider's own `merging` entry, so nothing else must exist to be named.
- **A split has no give-up path.** It is one entry; before it commits, a crash simply loses it.

### Mutants

Mutants were made by script from each smallest model, as DEV-10 (d) says: drop each guard, drop each update, flip each `<`, `<=`, `>`, `>=`, and swap each pair of updates in one action.

| Option | Mutants | Caught | Equivalent | Survived | Caught, of the non-equivalent |
|---|---|---|---|---|---|
| `pslot` | 59 | 43 | 16 | 0 | 100% |
| split + merge | 59 | 46 | 13 | 0 | 100% |
| lanes | 50 | 39 | 11 | 0 | 100% |
| `lanes-carry` | 46 | 35 | 11 | 0 | 100% |
| `pslot-fused` | 45 | 34 | 11 | 0 | 100% |

Every equivalent mutant swaps two updates that write different fields of one entry; their order cannot matter. Counted as DEV-03 counts (equivalents included): 73%, 78%, 78%, 76% and 76%; all are 100% once the equivalent swaps are set aside, so DEV-03's 85% holds in the sense part 1 used.

### States and seconds

| Option | States as written: grow, shrink, both, read, deep, twice | Smallest model, same bounds, then `twice1` | Seconds, the sweep as written |
|---|---|---|---|
| `pslot` | 22,797; 22,797; 39,409; 62,653; 53,644; 1,318 | 1,086; 1,086; 2,262; 2,625; 5,036; 154; 487 | 28 |
| split + merge | 234; 1,616; 398; 532; 540; 153 | 234; 468; 398; 532; 540; 72; 209 | under 1 |
| lanes | 22,797; 22,797; 39,409; 62,653; 53,644; 1,318 | 1,086; 1,086; 2,262; 2,625; 5,036; 203; 660 | 65 |
| `lanes-carry` | the same as lanes | 1,086; 1,086; 2,262; 2,625; 5,036; 154; 487 | 37 |
| `pslot-fused` | 1,799; 1,799; 3,541; 4,121; 4,241; 102 | 234; 234; 398; 532; 540; 44; 115 | 2 |

Seconds are wall time on a box shared with other agents' TLC (load 4 to 14): rough sizes only. Every sweep here finishes in seconds to a minute, far inside DEV-03's hour. The whole ablation of an option took from under a minute (split) to about 2.5 hours of wall time (`pslot`, whose greedy pass met models of up to 1.4 million states while resource names were dropped, on a box at load 7 to 14 and behind other agents' timing holds). Model lines (code only, as written): `pslot` 402 (its model and the loader of the probe), split 294, lanes 368 (with its two variants), `pslot-fused` 235; slot 363 and fixN 79 for reference.

### Other greedy orders

Part 1 found that the greedy order can pick a different one of two twin rules. Every option here was also run with the greedy drops in reverse model-text order:
- `split-rev` keeps exactly `split`'s 33; `lanes-rev` exactly `lanes`' 28; `pslot-fused-rev` exactly `pslot-fused`'s 24 (in lanes, `fence.N` and the carried epoch are no longer twins: N is the lineage base, the epoch orders positions).
- `pslot-rev` keeps 30 rules, `pslot`'s set with N in the fence (`fence.N`) in place of the carried sequence (`final.seq`): the same twin part 1 found for slot (`slot-rev`). The 4 naming rules are the same in both orders.

### The bigger bounds

See finding 6 below and [results/extra.txt](results/extra.txt): `readback` needs `fence.once` back in every set that keeps N in the fence (`slot-rev`, `pslot-rev`, lanes in both orders) and `merged.base` back in split + merge; everything else holds.

## Findings that could change a candidate

1. **`pslot` costs 4 rules over slot, all of one kind.** A group that holds slots of several resources must name the resource in every move entry that changes who holds a slot or names the move (`exporting`, the fence, the final copy, `open`). Nothing else changes: every rule of slot's smallest move is needed, and no other rule is added, in both greedy orders. With the names in place, the state graphs equal slot's at every bound. For DEV-01 this is "no new mechanism, 4 more rules"; for DEV-02 it adds no interacting pair, since the name is a field of the move's own entries. What `pslot` buys (SC-13: many small resources in few groups) is outside this harness, and so are its two reasoned extras: the placement guard (equal `copies` and durability per group) and, if groups are deleted, "never create a resource into a group that is being deleted" (about 2 rules, the two kinds of rule again). *Moves: MIN-P down on DEV-01 by 4 rules against MIN (not a tie under DEV-10's judging rule); SPACE §2's "0 beyond P `slot`" should read "0 new mechanisms, 4 rules".*
2. **Split + merge needs 7 more rules than slot moves (8 with readers across merges), because it is two protocols.** The split itself is cheap (9 rules beyond fixN) and copies nothing. Shrinking needs the merge, a second protocol with its own fence, commit waits, generation and carried state (11 rules), and readers need lineage in both directions (2 to 3 rules). SPACE's "about 8 rules" for splits is right for the split alone (9 here), but SPLIT's row needs the merge to meet SC-04, and with it, it is 33 to 34 core and 39 with a merge that can be given up. CockroachDB's "merges took years" is consistent with this: the merge is the bigger half. *Moves: SPLIT down on DEV-01 (33 to 34 against 26) and DEV-02 (two protocols share the write path and the reader's lineage); SPLIT up on SC-08(f) for the split direction (no copy).*
3. **Lanes' range move is the slot move; lanes lose on scale, not on rules.** On the slot move's protocol, a range move between lanes needs exactly slot's 26 rules if the copy carries the records, and 28 if records stay behind and readers follow lineage (LANE's per-lane offsets). Each range also needs an epoch carried by every move, or its positions fall when it moves back to a lane with a shorter log (P2): the per-lane offset of SPACE O `off` is not enough by itself, it is `off+lin`. What fails is structural (reasoned): writers per project are capped at the lane count, shared by every resource, and lane groups never shrink. *Moves: LANE down on SC-03 and SC-04 (by design), and on DEV-09 (its positions must gain an epoch and lineage in phase 5, a format change unless fixed now); LANE's phase-5 range move priced at slot's rules + 2.*
4. **The drafted slot move has a 4-rule shape cost that a split does not pay.** In the probe `pslot-fused`, A's first entry is the fence (the decision and the fence at once) and B's one entry is the final copy, which opens the slot: 9 rules beyond fixN for the move, against the drafted 13. The 4 that go are the `exporting` entry, the `open` entry, the `END(N)` marker that tells the final copy from the bulk copy, and "one final copy" (a copy taken at the fence is the same entry if repeated: see 5). "Export only a slot you hold" stays, as "fence only a slot you hold". The drafted shape's extra entries serve the bulk copy, which part 1 showed is a performance rule (it shortens the unwritable window, SC-08(b)). So the move can be specified as a 9-rule core (fence = decision, copy = open) plus a performance layer (announce, bulk copy, ready) checked against the core's properties (reasoned, as part 1's finding 1 proposed). With a give-up path the fused move needs 28 rules against 33 to 34. *Moves: every slot row (MIN family, DRAFT) up on DEV-01 and DEV-03 if DESIGN-V5 §4.2's move is restated this way; the comparison with SPLIT then reads 22 against 33.*
5. **Some counts depend on how the model times a copy, by 1 rule.** Slot's model takes the final copy from A's whole committed log at the time of the copy, so a second copy can differ, and "one final copy" (`final.once`) is needed. A split trigger, and the fused probe, take the state at the fence entry, fixed once it commits, so a second copy is the same entry and needs no guard. The probe `lanes-atfence` checks it: lanes' smallest set with the copy taken at the fence and `final.once` dropped holds every shared bound and `twice1`; lanes as ablated, with `final.once` dropped, fails P1 on `both` in 14 steps ([results/extra.txt](results/extra.txt)). So `final.once` is a rule of when the model takes the copy, not of the move: taken at the fence, lanes needs 27 on the shared bounds. This is a modelling choice the harness leaves to each option; DEV-10's tie rule (a difference under 2) covers it, but a second agent should know it.
6. **The shared bounds miss rules that slightly bigger bounds need, part 1's included.** Every smallest set, part 1's and part 2's, was run on three bigger bounds ([extra.py](extra.py), [results/extra.txt](results/extra.txt)). `bothread` broke nothing. `readback` (grow, then shrink back, with the reader and two writes) broke three kinds of set, each fixed by one rule put back:
   - **Sets that keep N in the fence need "fence a move once" (`fence.once`):** `slot-rev` (part 1), `pslot-rev`, and lanes in both orders. After a move and a move back, a stale fence of the first move, with a new N, lands in the old source and closes the slot again: L7 in 17 steps. The text-order sets of slot and `pslot` pass only because they dropped N from the fence: a stale fence is then an exact repeat, which the harness ignores by convention. A real log does not ignore a repeated entry, so **every slot move needs "fence a move once" once moves go both ways** (reasoned from these traces); the shared sweep never moves a slot back after a write.
   - **Split + merge needs the merge's lineage base (`merged.base`):** a reader crossing a merge with records on both sides takes a record of the merged group before the last one of the old group: P4 in 15 steps.
   - Nothing else: fixN, slot (text order), `pslot` (text order), `rekey-carry`, `lanes-carry` and `pslot-fused` hold all three bounds; of the give-up sets, `slot+abort` and `pslot-fused+abort` hold `readback` and `bothread`, and `split+giveup` needs `merged.base` back as its core does (`pslot+abort` and `lanes+abort` hold `readback` and `bothread` too; `readback1` with a give-up path passes 1.5 million states, undecided, so it was left out for those sets).
   
   So on the bigger bounds the counts are: slot 26 to 27, `pslot` 30 to 31, lanes 29, split + merge 34, `lanes-carry` 26, `pslot-fused` 24. The gaps between options do not change by more than 1. *Moves: none between candidates; the shared sweep (part 1's `bounds.py`) should gain `readback` before a third agent re-runs the ablations, and DESIGN-V5 §4.2's move should say "a move is fenced once" in words.*

## Re-check after the restarts (2026-11-08)

**Why.** The container restarted several times while part 2 ran. The harness caches each finished run by which rules were dropped, not by the model's text (part 3 points this out). If a model file was edited after some of its runs were cached, a cached run of the older text could in principle have slipped into a result.

**What.** [recheck.py](recheck.py) runs, fresh and with no cache, every part-2 result's model as written and its smallest model on every sweep bound (and the smallest on `twice1`), and compares each state count and state-set digest with the stored one. All 13 results: `pslot`, `pslot-rev`, `pslot+abort`, `split`, `split-rev`, `split+giveup`, `lanes`, `lanes-rev`, `lanes+abort`, `lanes-carry`, `pslot-fused`, `pslot-fused-rev`, `pslot-fused+abort`.

**Result (model-checked here).** All 169 checks give the same states and the same digest, with no property failing ([results/recheck.txt](results/recheck.txt)). So the model files as they stand are exactly the ones the results describe. This check does not re-derive the smallest sets or re-run the mutants; part 3's fresh re-run ([../E17c-partitioning-rerun](../E17c-partitioning-rerun/README.md)) does that.

## Requirements: which options can meet SC-03, SC-04 and SC-08

"Holds" means model-checked at the bounds above, with crash-only faults. "By design" rows are structural arguments (reasoned), not model results; judging rule 1 asks a second agent to confirm them in writing.

| Requirement | slot moves (part 1) | `pslot` | split + merge | lanes + range moves |
|---|---|---|---|---|
| SC-03, writes scale up, no count to choose; ceiling ≥ F_w per resource | up to E-18's effective number of the slot count (model: `grow` holds) | as slot; also lets small resources share groups | no fixed ceiling: splits go down to one partition (model: `grow` holds) | **fails by design** (reasoned): the lane count (64) is fixed per project and shared by every resource, so a resource gets at most 64 writers, fewer when other resources are busy or load is skewed (E-18 counts the effective number). Range moves rebalance inside the lanes; they add no lane |
| SC-04, scale down | the same move empties a group (model: `shrink` holds) | as slot | **only with merges** (model: `shrink` holds with the merge protocol); a split alone never shrinks | ranges move back (model: `shrink` holds), but **the lane groups never go away** (reasoned): a project pays 64 groups whatever its load |
| SC-08(a), no acknowledged write lost or doubled | holds (P1, P3) | holds | holds | holds |
| SC-08(b), unwritable ≤ 10 ms per move **while others go on** | one slot fenced | one slot fenced | a split fences the moving half until the new group's init commits (one commit, no copy); **a merge freezes every partition of the merged group** until `merged` commits, and needs the two groups' replicas on the same servers first (reasoned, from CockroachDB's merge) | one range fenced |
| SC-08(d), no cursor, version or token changes meaning | holds (P2, P3, P4) | holds | holds with lineage (P4 needs the merge's base on `readback`) and generations | holds with lineage and the range's epoch |
| SC-08(e), no human step | holds in the model | holds | holds | holds |
| SC-08(f), data moved per added server ≤ its share | one slot copied | one slot copied | a split copies nothing; moving the new group's replicas copies its half, its share (reasoned) | one range copied |

## What the model leaves out

- **Everything part 1's harness leaves out** ([../E17-partitioning/README.md](../E17-partitioning/README.md), "What the model leaves out"): unclean recovery (every option would need more rules; slot_move.py found five for slot moves), groups that die for good (so no give-up is ever needed, and give-up paths are priced separately), membership and elections, clocks, routing, the length of the unwritable window, and sizes beyond two partitions, three groups and two changes.
- **Per option,** in its README: for `pslot`, the placement guard on equal `copies` and durability, resource creation inside a running group, and group deletion; for split + merge, moving and colocating replicas (where a split's and a merge's data is really copied), reads of state during a change, and splits of splits; for lanes, range boundaries chosen at move time and the lane count's own costs.
- **The probe is a probe.** `pslot-fused` shows what the move's shape costs. A fused move without a bulk copy keeps the slot unwritable for the whole copy, so a real one needs the performance layer back (an announcement, the bulk copy, the ready report); this harness cannot price the window (SC-08(b), E-13).
- **Give-up paths with two deciders** were not re-run for the new options: part 1 showed the drafted two-decider give-up costs 4 to 5 rules more than one decider for slot, and `pslot`'s and lanes' moves are slot's. `./run.sh pslot+giveup` runs it for `pslot`; it was not run, to stay within the budget.
- **A few short development runs** (seconds each, a few minutes in all) ran outside the heavy lock between about 05:35 and 05:52 UTC, while E-09a2's timing hold `b2` (started 05:25) was waiting for or holding the box. Every result reported here ran under the lock.

## Verdict

**Threshold** (QUESTIONS Q-17): among the options meeting SC-03, SC-04 and SC-08, the fewest necessary rules wins axis P. Part 1 and part 2 together have now checked all six options on one harness.

- **Who meets the requirements.** Slot moves, `pslot` and split + merge meet SC-03, SC-04 and SC-08 (a), (d) and (e) in the model. Split + merge meets SC-04 only through its merge, and its merge freezes every partition of the merged group at once (SC-08(b), reasoned). Lanes + range moves meet SC-08 like slots, but fail SC-03's floor and SC-04 by design (reasoned): the lane count is fixed per project, shared by every resource, and never shrinks. fixN fails SC-03 and SC-04; re-key fails SC-08(b) and (f) (part 1).
- **The fewest necessary rules among those that meet them: slot moves, 26** (26 to 27 on the bigger bounds), against **30** for `pslot` (30 to 31) and **33** for split + merge (34). With working one-decider give-up paths: slot 33 to 34, `pslot` 39 to 40, split + merge 39 (lanes 36 to 37). Every difference is 2 or more, so none is a tie under DEV-10's judging rule.
- **So slot moves win axis P**, now against all six options.
- **`pslot` is an axis-G choice with a price of 4 rules**, all naming the resource in the move's entries, and no new mechanism. Whether SC-13 (many small resources in few groups) is worth 4 rules is for the verdict to weigh with E-36.
- **Split + merge loses because it is two protocols.** Its split is as small as a slot move written the same way (9 rules beyond fixN) and copies nothing, but shrinking needs a second, larger protocol (11) and lineage in both directions.
- **Lanes' range move is the slot move** (+2 rules of lineage, +0 if records travel); lanes lose on scale, not on rules.
- **The slot move should be written as a smaller core.** The probe shows the move's safety core is 9 rules beyond fixN when the fence is the decision and the final copy opens the slot (about 22 in all, 28 with a one-decider give-up path; reasoned from the probe's 24 and 31 less its naming rules), with the announcement, bulk copy and ready report as a performance layer on top, and "a move is fenced once" written down.

Q-17 (part 2): slot moves stay the smallest option that meets SC-03, SC-04 and SC-08: 26 necessary rules (26 to 27 on bigger bounds), against 30 for `pslot` (slot's rules plus 4 that name the resource in each move entry), 33 to 34 for split + merge (two protocols: a 9-rule split and an 11-rule merge, plus lineage) and 28 to 29 for lanes + range moves (the slot move plus 2 lineage rules, 26 with records carried), which also fails SC-03's floor and SC-04 by design; a slot move fused the way a split is written needs about 22 (model-checked, crash-only faults; the 22 reasoned from a 24-rule probe with naming). Moves: MIN and every slot row up on DEV-01 and DEV-03 (smallest of all six options, smaller still if DESIGN-V5 §4.2's move is fused); MIN-P down on DEV-01 by 4 rules against MIN, with no new mechanism; SPLIT down on DEV-01 and DEV-02 (two protocols, lineage kept for ever), up on SC-08(f) for splits; LANE down on SC-03, SC-04 and DEV-09 (its per-lane offsets need an epoch and lineage), with its phase-5 range move priced at slot's rules plus 2.
