# E-17 (part 3): the independent re-run, and the hunt for missed and extra rules

**Question (Q-17, the second agent's step).** [QUESTIONS.md](../../QUESTIONS.md) asks that "a second agent re-runs each ablation" of E-17. This is that agent. Two questions:
1. **Do the counts reproduce?** Re-run every ablation of [part 1](../E17-partitioning/PART1.md) and [part 2](../E17b-partitioning-part2/README.md) from scratch. Do the rule counts, the mutant results and the state counts come out the same?
2. **Are the counts right?** Is there a rule an option needs that the shared harness never asks for (a missed property, or a bound too small to show it)? Is there a rule counted that the option does not really need?

The E-17 verdict, which uses these results, is in [../E17-partitioning/README.md](../E17-partitioning/README.md).

## The answer, first

TBD

## Method

**Words used here.** A *rule* is one guard conjunct or one state update of a model action; it counts only if removing it lets the checker find a counterexample (REQUIREMENTS DEV-10). *Ablation* is the search that removes rules one by one to find the smallest set where every rule counts. A *smallest set* is *1-minimal*: removing any one rule left breaks a property. A *mutant* is the smallest model with one mechanical change (a guard or update dropped, a `<` turned into `<=`, two updates swapped). A *bound* is the size of one check: which scale changes, which client writes, how many leader crashes.

**1. The re-run, from scratch.** [run.sh](run.sh) copies E-17's harness and models into the scratchpad (`$SP/e17c/work`) and checks the copy is byte-identical to the files parts 1 and 2 reported on ([results/sources.sha256](results/sources.sha256)). Then it runs the same commands as parts 1 and 2's `run.sh`, with the same flags and warm starts, but with **fresh checkpoints**: no cached run of the first agents is reused. (A checkpoint caches finished runs keyed only by which rules were dropped, not by the model's text; the models and `runner.py` changed after some original results were written, so a stale cache entry could have survived there. A fresh run cannot inherit one.) Every run went through `$SP/bin/heavy` with two worker processes, in pieces of 20 minutes, as before. [compare.py](compare.py) then compares the two field by field: the rules kept and removed, each rule's verdict when dropped alone (pass 1) and in the final pass, the state count and state-set digest of the model as written and of the smallest model on every bound, the verify bound, and every mutant ([results/compare.md](results/compare.md)).

**2. The cheaper check, where a full re-run did not fit.** The other greedy orders (`-rev`) and most give-up prices take as much CPU again as the cores. Within the budget, [verify.py](verify.py) checks the original smallest set of each of them fresh instead: it holds every sweep bound with the same state sets, and dropping any one kept rule breaks a property with the same first failure (bound, property, steps). That proves the reported count is a correct 1-minimal set; it does not re-derive it from the full model.

**3. The hunt** ([hunt.py](hunt.py), [models/](models)). Every check is outside the shared sweep, so the shared counts stay comparable:
- **L8, "others go on"** (SC-08(b): a partition is unwritable during its own move "while others go on"). From every reachable state, an attempt on a partition the bound never moves must be answerable by client steps and commits alone: no step of the change, no crash, no timer. Parts 1 and 2 argued it in words for re-key ("the cut-over freezes every partition"); this checks it.
- **F8, "copy only what moves"** (SC-08(f): data moved ≤ the added server's share). No reachable state holds rows of a partition the bound never moves anywhere but in the group that held it at the start.
- **R, a step taken twice.** The harness drops an append of an entry already in the log, so a guard that only stops an exact repeat is never counted (HARNESS.md). A real log appends it: a handler that runs twice (an at-least-once delivery, a retry) writes its entry twice unless a guard stops it. R lets each entry be appended once more and asks which smallest set still holds, and which dropped rule must come back.
- **B, bigger bounds.** Part 2's three (`readback`, `readback1`, `bothread`) on this re-run's sets, and three with a **third group**, which no shared bound has: `chain3` (p moves G0 → G1 → G2, two writes, the reader on), `chain3c` (the same with one leader crash, one write), `fork3` (p and q leave G0 for G1 and G2 in one change, one crash).
- **Two counting probes** (`models/`), each one model with one thing changed, ablated from this re-run's set:
  - `slotkey`: pslot's model with p and q in two slots of **one** resource, so the half of the slot key that each entry sets by its own update is the slot number, not the resource. It asks whether pslot's four "naming" rules are a cost of shared groups or of how the two models count their keys.
  - `slotprobe-trig` and `slotprobe-atfence`: slot's model with B's `open` trigger written as a guard instead of a filter in its parameters, and with the final copy taken at the fence. They ask whether `final.end` and `final.once` are rules of the move or of how the model is written.

**Box and versions.** Linux 6.18 (Firecracker VM), 4 vCPU, 15 GB; Python 3.13.17, standard library only ([results/machine.txt](results/machine.txt)). The box was shared with other agents' TLC, simulations and timing holds, so seconds are sizes, not timings.

**Reproduce.** `./run.sh` runs everything in this README in order (`cheap cores variants warm verify extra table compare`); `./run.sh orders giveups` re-derives the other orders and the give-up prices in full (not run here: budget). One hunt check: `python3 hunt.py --work $SP/e17c/work bigger --only split`.

## Results

TBD

## What this leaves out

TBD

## Verdict

TBD
