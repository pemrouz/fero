# E-17 (part 3): the independent re-run, and the hunt for missed and extra rules

**Question (Q-17, the second agent's step).** [QUESTIONS.md](../../QUESTIONS.md) asks that "a second agent re-runs each ablation" of E-17. This is that agent. Two questions:
1. **Do the counts reproduce?** Re-run every ablation of [part 1](../E17-partitioning/PART1.md) and [part 2](../E17b-partitioning-part2/README.md) from scratch. Do the rule counts, the mutant results and the state counts come out the same?
2. **Are the counts right?** Is there a rule an option needs that the shared harness never asks for (a missed property, or a bound too small to show it)? Is there a rule counted that the option does not really need?

The E-17 verdict, which uses these results, is in [../E17-partitioning/README.md](../E17-partitioning/README.md).

## The answer, first

All results are **model-checked here** unless marked reasoned.

- **Yes, the counts reproduce, exactly.** Twenty ablations re-derived from scratch, on a byte-identical copy of the harness with fresh caches, give the same smallest sets, the same verdict for every rule (dropped alone and in the final pass), the same 517 mutants row by row, and the same state sets on every bound. The five one-decider give-up sets, checked fresh, hold with the same state sets, and every rule in them breaks a property when dropped (or stops at the state limit, where the original kept it as undecided) with the same first failure: 179 of 179 rules agree. The only difference is the order of two rules inside the final pass of `slot` and `rekey`, which changes nothing counted.
- **One count means something other than what part 2 said: `pslot`'s 4 extra rules.** The probe `slotkey` is `pslot`'s model with two slots of one resource instead of one slot of two resources. It keeps the same 30 rules, with the same 4 naming rules failing in the same way. So the 4 rules name the slot key in **any** slot move; slot's model built the key into each entry where ablation never asks. Counted the same way, slot moves and `pslot` need the same rules.
- **Re-key's SC-08 failures are now model-checked.** In every re-key set (as written and smallest), a write to a partition that never moves waits for the re-key (L8 fails: SC-08(b), "while others go on"), and that partition's rows are copied (F8 fails: SC-08(f)). Every other option passes both.
- **Rules the shared bounds miss.** A third group needs "split only a partition you hold" in split + merge (new: two holders in 5 steps without it). Part 2's two `readback` rules reproduce (`fence.once` where N is in the fence; `merged.base`). And a real log, where a step can run twice, needs once guards in every option but fixN: 2 for slot moves, `pslot` and lanes ("fence a move once", "open a move once"), 2 for split + merge, 1 to 3 for re-key, 1 for the fused move.
- **Everything at once** (the bigger bounds and a step taken twice): fixN 13, slot moves **28**, `pslot` 32 (28 on slot's footing), lanes 30, `lanes-carry` 28, split + merge **37**, re-key 36 to 38 as CELL writes it and 30 to 32 with carried positions (two once guards stay undecided at 1.5 million states), the fused move 25.
- **Rules counted that the move does not need:** only "take the final copy once" (`final.once`), a rule of when the model takes the copy (25 when taken at the fence; a real log puts it back). The `END(N)` marker stays needed when its filter is a guard; "one move of a slot at a time" is not needed even with a third group.
- **So the order of the options does not change, but two gaps do:** `pslot` against slot moves closes from 4 to 0, and split + merge against slot moves widens from 7 to 9.

## Method

**Words used here.** A *rule* is one guard conjunct or one state update of a model action; it counts only if removing it lets the checker find a counterexample (REQUIREMENTS DEV-10). *Ablation* is the search that removes rules one by one to find a smallest set where every rule counts. A *smallest set* is *1-minimal*: removing any one rule left breaks a property. A *mutant* is the smallest model with one mechanical change (a guard or update dropped, a `<` turned into `<=`, two updates swapped). A *bound* is the size of one check: which scale changes, which client writes, how many leader crashes. A *once guard* stops an action from writing an entry its log already holds.

**1. The re-run, from scratch.** [run.sh](run.sh) copies E-17's harness and models into the scratchpad (`$SP/e17c/work`) and checks the copy is byte-identical to the files parts 1 and 2 reported on ([results/sources.sha256](results/sources.sha256); still identical on 2026-11-08). Then it runs the same commands as parts 1 and 2's `run.sh`, with the same flags and warm starts, but with **fresh checkpoints**: no cached run of the first agents is reused. (A checkpoint caches finished runs keyed only by which rules were dropped, not by the model's text, and some original results were written before the harness's last edits, so a stale cache entry could have survived there. A fresh run cannot inherit one.) The other greedy orders (`-rev`) start from this re-run's own core checkpoints, as part 1 seeded them from its own. Every run went through `$SP/bin/heavy` with two worker processes, in pieces of 20 minutes. [compare.py](compare.py) then compares the two field by field: the rules kept and removed, each rule's verdict when dropped alone (pass 1) and in the final pass, the state count and state-set digest of the model as written and of the smallest model on every bound, the verify bound `twice1`, the warm start, and every mutant ([results/compare.md](results/compare.md)).

**2. The give-up prices: checked, not re-derived.** A give-up path makes a model 30 to 260 times bigger, and re-deriving one give-up set costs 2.5 to 6 CPU-hours (from the originals' caches). Within the budget, [verify.py](verify.py) checks each of the five one-decider give-up sets fresh instead (`slot+abort`, `pslot+abort`, `lanes+abort`, `rekey-carry+giveup`, `rekey+giveup-alt`; `split+giveup` and `pslot-fused+abort` were cheap and were re-derived in full): the original smallest set holds every sweep bound with the same state sets, and dropping any one kept rule breaks a property with the same first failure (bound, property, steps), or stops at the state limit again where the original kept it as undecided. That proves the reported count is a correct 1-minimal set; it does not re-derive it from the full model.

**3. The hunt** ([hunt.py](hunt.py), [models/](models), [results/hunt.txt](results/hunt.txt)). Every check is outside the shared sweep, so the shared counts stay comparable:
- **L8, "others go on"** (SC-08(b): a partition is unwritable during its own move "while others go on"). From every reachable state, an attempt on a partition the bound never moves must be answerable by client steps and commits alone: no step of the change, no crash, no timer. Parts 1 and 2 argued it in words for re-key ("the cut-over freezes every partition"); this checks it.
- **F8, "copy only what moves"** (SC-08(f): data moved ≤ the added server's share). No reachable state holds rows of a partition the bound never moves anywhere but in the group that held it at the start.
- **B, bigger bounds.** Part 2's three (`readback`, `readback1`, `bothread`) on this re-run's sets, and three with a **third group**, which no shared bound has: `chain3` (p moves G0 → G1 → G2, two writes, the reader on), `chain3c` (the same with one leader crash, one write), `fork3` (p and q leave G0 for G1 and G2 in one change, one crash). Where a set fails, a search finds which dropped rule, put back, makes that bound and the whole sweep hold.
- **R, a step taken twice.** The harness drops an append of an entry already in the log, so a guard that only stops an exact repeat is never counted (HARNESS.md). A real log appends it: a handler that runs twice (an at-least-once delivery, a retry after a leader change) writes its entry twice unless a guard stops it. R lets each entry be appended once more (at most two copies) and asks which smallest sets still hold, and which dropped rules must come back. Split's and the fused probe's models never wrote once guards (their entries were exact repeats by construction), so R runs them with once guards added in the same shape ([models/once](models/once/model.py)), all starting dropped.
- **C, both at once.** Each core set with every rule R or B put back, run with a step taken twice on all the bounds at once (the sweep, `twice1` and the bigger bounds); then each rule put back is dropped again alone, and must break a bound. This is the count of a move that is safe in a real log at the bigger bounds.
- **Three counting probes** ([models/](models)), each one model with one thing changed, ablated warm from this re-run's set:
  - `slotkey`: `pslot`'s model with p and q in two slots of **one** resource, so the half of the key each move entry sets by its own update is the slot, not the resource. It asks whether `pslot`'s four "naming" rules are a cost of groups shared across resources, or of how the two models write the key.
  - `slotprobe-trig`: slot's model with B's `open` trigger written as a guard (`open.final`), not as a filter in the action's parameters. Does `final.end` (the `END(N)` marker) stay needed?
  - `slotprobe-atfence`: slot's model with the final copy taken at the fence entry, not from A's whole committed log at the time of the copy. Is `final.once` a rule of the move or of when the model takes the copy?

**Box and versions.** Linux 6.18 (Firecracker VM), 4 vCPU, 15 GB; Python 3.13.17, standard library only ([results/machine.txt](results/machine.txt)). The box was shared with other agents' model checks, builds and timing holds (load 1 to 13), so seconds are sizes, not timings. Wall time per run is in [results/walltime.txt](results/walltime.txt). The work was cut by a usage stop and a container restart; every finished run was kept, and each unfinished one carried on from its own fresh checkpoint on 2026-11-08 and 09.

**Reproduce.** `./run.sh` runs everything in this README in order (`cheap cores variants warm orders verify extra settle table compare`), about 19 CPU-hours of model checking on this box. `./run.sh giveups` re-derives the give-up prices in full and `./run.sh verify2` checks the two give-up sets left out; neither was run here (budget). One hunt check: `python3 hunt.py --work $SP/e17c/variants --res $SP/e17c/work/results bigger --only split`.

## Results

### 1. Do the counts reproduce? Yes, exactly

Every ablation this re-run re-derived (20 results) came out the same as parts 1 and 2 in every field [compare.py](compare.py) compares ([results/compare.md](results/compare.md), model-checked here): the same smallest set; the same verdict for every rule, dropped alone and in the final pass (the same bound, property and number of steps); the same mutants, row by row (517 mutants on 11 sets); and the same state sets, as written and smallest, on every bound and on `twice1` (equal state-set digests, so the graphs are identical, not just the same size). The re-run's own result files (about 1.2 MB of JSON) stay in the scratchpad (`$SP/e17c/work/results`), and `./run.sh` rebuilds them; the give-up checks are in [results/verify/](results/verify).

| Result | Rules as written | Kept, original / re-run | Mutants (re-run = original, row by row) | States, sum of 6 sweep bounds: as written / smallest / `twice1` |
|---|---|---|---|---|
| fixN | 14 | 13 / 13 | 18: 17 caught, 1 equivalent, 0 survived | 220 / 220 / 6 |
| slot | 69 | 26 / 26 | 46: 35 caught, 11 equivalent, 0 survived | 202,618 / 12,249 / 487 |
| slot-rev | 69 | 26 / 26 | - | 202,618 / 12,298 / 660 |
| rekey | 57 | 35 / 35 | 53: 44 caught, 8 equivalent, 1 survived | 1,026,569 / 13,896 / 1,147 |
| rekey-rev | 57 | 35 / 35 | - | 1,026,569 / 13,896 / 1,147 |
| rekey-alt | 57 | 34 / 34 | 52: 43 caught, 8 equivalent, 1 survived | 1,026,569 / 11,637 / 1,015 |
| rekey-carry | 51 | 29 / 29 | 45: 38 caught, 7 equivalent, 0 survived | 1,011,043 / 13,371 / 1,147 |
| rekey-carry-rev | 51 | 29 / 29 | - | 1,011,043 / 13,371 / 1,147 |
| rekey-carry-alt | 51 | 28 / 28 | 44: 37 caught, 7 equivalent, 0 survived | 1,011,043 / 11,124 / 1,015 |
| pslot | 80 | 30 / 30 | 59: 43 caught, 16 equivalent, 0 survived | 202,618 / 12,249 / 487 |
| pslot-rev | 80 | 30 / 30 | - | 202,618 / 12,298 / 660 |
| split | 47 | 33 / 33 | 59: 46 caught, 13 equivalent, 0 survived | 3,473 / 2,244 / 209 |
| split-rev | 47 | 33 / 33 | - | 3,473 / 2,244 / 209 |
| split+giveup | 47 | 39 / 39 | - | 3,473 / 3,529 / 531 |
| lanes | 68 | 28 / 28 | 50: 39 caught, 11 equivalent, 0 survived | 202,618 / 12,298 / 660 |
| lanes-rev | 68 | 28 / 28 | - | 202,618 / 12,298 / 660 |
| lanes-carry | 67 | 26 / 26 | 46: 35 caught, 11 equivalent, 0 survived | 202,618 / 12,249 / 487 |
| pslot-fused | 35 | 24 / 24 | 45: 34 caught, 11 equivalent, 0 survived | 15,603 / 1,982 / 115 |
| pslot-fused-rev | 35 | 24 / 24 | - | 15,603 / 1,982 / 115 |
| pslot-fused+abort | 35 | 31 / 31 | - | 15,603 / 15,603 / 443 |

Two differences, neither in a count, a verdict or a state set:
- **The order inside the final pass.** In `slot` and `rekey` (and so in the warm-start lists of `rekey-carry`, `rekey-alt` and `rekey-carry-alt`, which copy `rekey`'s list), two rules that the final pass drops come in a different place: the original drops them in the pass's first round, the re-run in its second (`import.expcom` and `copy.once` for slot; `copy.append` and `copy.once` for re-key). The original files were written on 2026-11-06, before the runner's last edit (02:56 on 2026-11-07), and the original's cache now gives the re-run's order, so the old files most likely came from an earlier cache or runner state. The cause is not pinned down further. It changes nothing that is counted.
- **The warm start of `split+giveup` and `pslot-fused+abort`.** The originals record a refused warm start; the re-run uses none, as part 2's `run.sh` now asks. The sets are the same.

Wall time on the shared box: from 5 seconds (`split-rev`) to about 2.1 hours (`pslot`, in pieces over two days); about 15 hours in all, waits behind other agents' timing holds included ([results/walltime.txt](results/walltime.txt)). The caches record about 16 CPU-hours of model checking for the ablations and the give-up checks; the hunt and `settle.py` add about 3.

### 2. The give-up prices, checked fresh

The original smallest set of each one-decider give-up price, checked fresh by [verify.py](verify.py) ([results/compare.md](results/compare.md), model-checked here). A range counts the rules that stop at the state limit (1.5 million states) with no counterexample: undecided, so kept, as the originals did.

| Give-up set | Rules (pinned give-up steps) | Holds every bound, with the same state sets and `twice1` | Necessary | Undecided | Not needed | Same first failure as the original |
|---|---|---|---|---|---|---|
| `slot+abort` (slot, one decider) | **33 to 34** (2 pinned) | yes | 31 | 1 | 0 | 32 of 32 |
| `pslot+abort` (`pslot`, one decider) | **38 to 40** (2 pinned) | yes | 36 | 2 | 0 | 38 of 38 |
| `lanes+abort` (lanes, one decider) | **36 to 37** (2 pinned) | yes | 34 | 1 | 0 | 35 of 35 |
| `rekey-carry+giveup` (re-key, positions carried) | **34 to 35** (1 pinned) | yes | 33 | 1 | 0 | 34 of 34 |
| `rekey+giveup-alt` (re-key, CELL as written) | **40 to 41** (1 pinned) | yes | 39 | 1 | 0 | 40 of 40 |

- **All five reproduce**: 179 of 179 rules give the same first failure (bound, property and steps), or stop at the limit again. No rule kept by parts 1 and 2 turned out to be unneeded.
- `pslot+abort` shows as 38 to 40 here because both `abort.imp` and `export.res` stop at the limit in the give-up model; part 2 wrote 39 to 40 because `export.res` is decided necessary in the core model. Both readings are the same data.
- Not checked: the two-decider `slot+giveup` (part 1's 37 to 39) and the first `rekey+giveup` (superseded by `rekey+giveup-alt`); `./run.sh verify2` checks them.

### 3. L8 and F8: does a change leave the other partitions alone?

On the bounds `both`, `bothshrink` and `bothtwice` (one write to the partition that moves, one to q, which never moves), every model as written and every smallest set ([results/hunt.txt](results/hunt.txt), model-checked here):

| Sets | L8: q's write answered with no step of the change | F8: q's rows copied nowhere |
|---|---|---|
| fixN, slot (both orders, `+abort`), `pslot` (both orders, `+abort`), lanes (both orders, `+abort`), `lanes-carry`, split + merge (and `+giveup`), `pslot-fused` (and `+abort`): 66 runs | holds in all 66 | holds in all 66 |
| `rekey`, `rekey-alt`, `rekey-carry`, `rekey-carry-alt`, as written and smallest: 18 runs | **fails in all 18** | **fails in all 18** |

- **Re-key fails both, on every bound, as written and in every smallest set.** L8's trace: the catalog starts generation 2, both new cells copy, the catalog commits the cut-over, and old cell `g1c0` freezes. From then on q's write `w3` cannot be answered until the re-key's own final copy and flip go through, though the layouts never move q. F8's trace: q's write commits in `g1c0`, the re-key starts, and new cell `g2c0` copies q's rows. So parts 1 and 2's "re-key fails SC-08(b) and (f) by design" is now **model-checked**, not only reasoned.
- **Every other option holds both.** A slot, range or split change fences and copies only the partition it moves. (A merge does freeze every partition of the group it removes, but all of them move, so L8 cannot fault it; how long they wait is E-13's window.)

### 4. B: bigger bounds

The six bigger bounds on every smallest set (model-checked here; `+` sets on `readback` and `bothread` only):

| Set | `readback`, `readback1` | `bothread` | `chain3`, `chain3c` (third group, one partition moved twice) | `fork3` (two partitions to two new groups at once) |
|---|---|---|---|---|
| fixN | (no change to read back) | holds | - | - |
| slot, `pslot`, `lanes-carry`, `pslot-fused` | hold | hold | hold | hold |
| `slot-rev`, `pslot-rev`, lanes (both orders) | **L7 in 17 steps**: put back "fence a move once" (`fence.once`) | hold | hold | hold |
| re-key (all four sets) | hold | hold | (not run: a re-key places partitions by hash, and these layouts do not follow it) | - |
| split + merge (and `+giveup`) | **P4 in 15 steps**: put back the merge's lineage base (`merged.base`) | holds | **P6 in 5 steps**: put back "split only a partition you hold" (`split.open`) | holds |
| `slot+abort`, `pslot+abort`, `lanes+abort`, `pslot-fused+abort` | hold | hold | - | - |

- **Part 2's `readback` findings reproduce**: `fence.once` for every set that keeps N in the fence, `merged.base` for split + merge.
- **New: split + merge needs "split only a partition you hold" once there is a third group.** G0 splits p off to G1; before G1's init commits, G1 splits p on to G2 (it does not hold p yet); G2 inits p while G0's split is still settling: two groups hold p open (P6) in 5 steps. The shared sweep never splits a partition twice, so the rule was dropped. Slot moves have the twin rule ("export only a slot you hold", `export.open`) in their set already, because `twice` moves a slot back.
- **No new rule for slot moves at a third group.** Part 1 asked whether "one move of a slot at a time" (`export.one`) would be needed with a third group: on `chain3`, `chain3c` and `fork3` it is not, in any slot, `pslot` or lanes set. (The layouts start one change at a time, as one controller would; two controllers deciding at once are not modelled.)

### 5. R: a step taken twice, and C: everything at once

**R** ([results/hunt.txt](results/hunt.txt), model-checked here): every smallest set on the sweep and `twice1` with each entry allowed to be appended once more.

| Set | With a step taken twice | Rules that must come back |
|---|---|---|
| fixN | holds | none |
| slot, `pslot`, lanes, `lanes-carry` (both orders) | **P6 in 18 steps** (`twice`) | 2: "fence a move once" (`fence.once`) and "open a move once" (`open.once`) |
| `rekey`, `rekey-carry` | **P1 in 16 steps** (`grow`) | 1 to 3: "take the final copy once" (`final.once`) is needed (P1 in 16 steps without it); "freeze once" and "flip once" (`freeze.once`, `flip.once`) stay undecided even at 1.5 million states ([settle.py](settle.py), [results/settle.txt](results/settle.txt)) |
| `rekey-alt`, `rekey-carry-alt` | P1 in 14 steps | up to 2: `final.once`, `flip.once` (not settled past 300,000 states) |
| split + merge | P1 in 8 steps (`grow`) | 2: "init once", "merged once" (3 with `+giveup`: also "subsume once") |
| `pslot-fused` (and `+abort`) | P1 in 8 steps | 1: "final copy once" |
| `slot+abort`, `pslot+abort`, `lanes+abort` | undecided: `grow` passes 300,000 states with a step taken twice | not settled |

- The slot family's trace: p moves to G1 and back to G0; the first move's `open` entry is appended again at G1 after the move back, and G1 opens the slot a second time, so G0 and G1 both hold it (P6). Without `fence.once` a repeated fence closes the slot again at the wrong group (L7 in 15 steps). These are exactly the "a move is fenced once" rule part 2 found on `readback`, and its twin for `open`.
- These once guards are in every model as written (role `idem`), and the shared ablation drops them because the harness ignores an exact repeat by convention (HARNESS.md). Under that convention they are not counted for any option, so the shared counts stay fair to each other. But a real log does not ignore a repeated entry, so a build needs them. **No option escapes them**, and they add 0 to 3 rules to each.

**C**, both at once: each core set with every rule R or B put back, checked with a step taken twice on all its bounds at once (the 7 shared ones and up to 6 bigger ones), then each rule put back dropped again alone. hunt.py stops a run at 300,000 states; re-key stopped there, so [settle.py](settle.py) ran re-key's C checks again up to 1.5 million states ([results/settle.txt](results/settle.txt)):

| Option | Shared count | Put back | **C count** | Each rule put back, dropped again |
|---|---|---|---|---|
| fixN | 13 | none | **13** | - |
| slot | 26 | `fence.once`, `open.once` | **28** | L7 in 15 steps; P6 in 18 |
| `pslot` | 30 (26 on slot's footing) | `fence.once`, `open.once` | **32** (28) | L7 in 15; P6 in 18 |
| lanes | 28 | `fence.once`, `open.once` | **30** | L7 in 15; P6 in 18 |
| `lanes-carry` | 26 | `fence.once`, `open.once` | **28** | L7 in 15; P6 in 18 |
| `rekey-carry` | 29 | `freeze.once`, `final.once`, `flip.once` | **30 to 32** | `final.once`: P1 in 16; `freeze.once`, `flip.once`: undecided (every bound holds without either, except one or two that pass 1.5 million states) |
| `rekey` | 35 | the same 3 | **36 to 38** | the same as `rekey-carry` (the set with all 3 holds every bound; `readback1` at 433,913 states) |
| split + merge | 33 | `init.once`, `merged.once`, `merged.base`, `split.open` | **37** | P1 in 8; P1 in 10; P4 in 15; P6 in 5 |
| `pslot-fused` | 24 | `final.once` | **25** | P1 in 8 |

### 6. The counting probes

| Probe | What changed | Kept | Against | What it shows |
|---|---|---|---|---|
| `slotkey` | `pslot`'s model with p and q in two slots of **one** resource: the key half each move entry sets by its own update is the slot | **30**, the same 30 rules as `pslot`, with the same first failure for each of the 4 naming rules (`export.res` L7 in 6, `fence.res` L7 in 5, `final.res` P6 in 8, `open.res` P6 in 8), and slot's exact state counts | `pslot` 30, slot 26 | The 4 rules name **the slot key**, not the resource. Any slot move whose entries can forget which slot they are about needs them; slot's model builds the slot into each entry's append, where ablation never asks. So part 2's "`pslot` = slot + 4" is a difference in how the two models were written, not a cost of shared groups: counted the same way, slot moves and `pslot` need the same rules (26 each without naming, 30 each with it). |
| `slotprobe-trig` | slot's B opens on any copy, with "only on the final copy" as a guard (`open.final`) instead of a filter in the action's parameters | **26**, the same set; `open.final` is not needed, `final.end` still is (P1 on `both` in 14 steps) | slot 26 | The filter hid no rule: slot's count stands. |
| `slotprobe-atfence` | slot's final copy reads A's log up to the fence entry, not A's whole committed log at copy time | **25**: the same set less `final.once` | slot 26 | As part 2 found for lanes: "take the final copy once" is a rule of when the model takes the copy, not of the move. Taken at the fence, a second copy is the same entry. (In a real log it is still needed: R puts the once guard back.) |

### 7. What this changes in parts 1 and 2

1. **No count of parts 1 and 2 was wrong.** Every set, verdict, mutant and state set re-derived came out the same.
2. **`pslot` costs the same rules as slot moves** (probe `slotkey`), not 4 more. Part 2's finding 1 and its "MIN-P down on DEV-01 by 4 rules" do not hold: the 4 rules belong to every slot move, written the same way. The same holds for `pslot+abort`'s 2 extra names (`abort.res`, `unfence.res`, reasoned from the same probe: they are the same kind of name).
3. **Re-key's SC-08(b) and (f) failures are model-checked** (L8, F8), not reasoned.
4. **Split + merge needs 2 more rules than the shared sweep shows** (`merged.base`, part 2's; `split.open`, new), and 2 once guards in a real log: 37 against slot's 28 at the same footing.
5. **Every option needs once guards in a real log**: slot, `pslot` and lanes 2, re-key 1 to 3, split + merge 2, the fused move 1, fixN 0. The shared counts leave them all out on equal terms; the C counts put them all in.
6. **The slot move's `final.once` is a rule of copy timing** (probe `slotprobe-atfence`): 25 at the fence. That changes no comparison (in a real log the guard comes back).

## What this leaves out

- **Everything the shared harness leaves out** ([PART1.md](../E17-partitioning/PART1.md), "What the model leaves out"): unclean recovery (a committed entry cut back; slot_move.py found five more rules for slot moves there), groups that die for good, membership and elections, clocks, routing tables, the length of the unwritable window (E-13) and how much is copied (E-18). Every count here is under crash-only faults.
- **The give-up prices were checked, not re-derived.** For the five one-decider give-up sets, this re-run checked the original set fresh but did not run greedy from the full model again. So a different give-up set with fewer rules could exist; the counts are correct 1-minimal sets, as before, not proven smallest. The two-decider `slot+giveup` and the superseded first `rekey+giveup` were not re-checked (budget; `./run.sh verify2` does it). R on the give-up sets is undecided (with a step taken twice they pass 300,000 states on `grow`), and C was not run on them.
- **1-minimal is not minimum.** Greedy finds a set where every rule is needed; a different set with fewer rules may exist. Two orders (text and reverse), the warm-start twins and three probes were run; DEV-10's rule that a difference under 2 is a tie covers the rest.
- **R allows one repeat, not any number.** A step may be taken twice (at most two copies of an entry). That is enough to show which once guards a real log needs; it does not show what a third copy would need. R and C runs stop at 300,000 states (re-key's C checks at 1.5 million, in `settle.py`); some re-key once guards stay undecided even there.
- **L8 is a liveness check on client steps only.** It asks whether a partition that never moves can be answered with no step of the change. It does not measure how long a moving partition is unwritable (SC-08(b)'s 10 ms), which is E-13's.
- **F8 is per partition, not per byte.** It asks whether rows of a partition that never moves are copied anywhere. It does not price how much a moving partition copies (SC-08(f)'s "≤ its share"), which is E-18's.
- **The bigger bounds are still small.** Three groups, two partitions, two writes, one reader, at most two changes (three groups in `chain3`). A rule that only a fourth group, a third partition or two concurrent moves of the same slot would need does not show (the layouts start one change at a time, as a single controller would).
- **The probes are probes.** Each changes one thing in a model; they say how a count depends on how a model is written, not how a real system should be built.

## Verdict

**Did the counts reproduce?** Yes, exactly: 20 ablations re-derived from scratch and 5 give-up sets checked fresh give the same sets, verdicts, mutants and state sets as parts 1 and 2.

**Are the counts right?** The shared counts are right for what the shared harness asks. Three things change what they mean, none of them the order of the options:
- `pslot`'s 4 extra rules are a difference in how the models were written: on the same footing, `pslot` = slot moves.
- Re-key's SC-08(b) and (f) failures are model-checked, not reasoned.
- On bigger bounds and in a real log, every option needs a few more rules (0 to 3 once guards each; split + merge 2 more for its bigger bounds). On that footing (slot's way of writing the key): slot moves 28, `pslot` 28, `lanes-carry` 28, lanes 30, re-key 30 to 32 with carried positions and 36 to 38 as CELL writes it, split + merge 37, the fused move 23 (25 as counted).

Q-17 (part 3): Yes, E-17's counts reproduce exactly under a second agent (20 ablations re-derived from scratch with the same sets, per-rule verdicts, 517 mutants and state sets; 5 give-up sets checked fresh, 179 of 179 rules agreeing), and the hunt changes their meaning in three places: `pslot`'s 4 extra rules name the slot key in any slot move (probe `slotkey`: slot needs the same 4 when counted the same way), re-key's SC-08(b) and (f) failures are now model-checked (L8, F8), and split + merge needs `split.open` once a third group exists; once guards for a real log add 0 to 3 rules to every option, so on the same footing slot moves need 28, `pslot` 28, lanes 30, re-key 30 to 38 and split + merge 37 (model-checked, crash-only faults). Moves: MIN-P up on DEV-01 (it ties MIN on axis P; part 2's 4-rule penalty is withdrawn); CELL down on SC-08(b) and SC-08(f) (now model-checked); SPLIT down on DEV-01 (37 against 28); MIN and every slot row up on DEV-01 and DEV-03 (their counts stand under a second agent and stay the smallest on every footing).
