# rekey and rekey-carry: fixN, grown by copying into a new generation

**What it is.** fixN, plus a way to change N: copy the whole resource into a new generation with a different cell count, then switch the catalog pointer under a fence (SPACE P `rekey`; V5-PRIMITIVE §3 item 4: "re-keyed by the derived-resource library into a new generation with more cells, then the catalog pointer switches under a fence"; the CELL candidate). V5-PRIMITIVE gives one sentence, so the steps here follow the published workflow it names in spirit, Vitess's Reshard (VReplication): the new shards copy while writes go on, then a cut-over stops writes at the old shards, the new shards catch up to that point, and routing switches ([Vitess Reshard docs](https://vitess.io/docs/reference/vreplication/reshard/)).

**The model:** [model.py](model.py). Group 0 is the catalog (`#meta` in fero), whose log holds the workflow's decisions. Each generation has its own cells: generation k has as many cells as the bound's k-th layout has groups, and a partition goes to cell `hash mod count`. Every re-key copies into **new** cells, so a grow from 1 to 2 cells runs three cells and the catalog, and `twice` (1, 2, then 1 again) runs four cells and the catalog.

The steps, as modelled:
- **start:** the catalog commits `rk(G, src)`: re-key into generation G from the current generation `src`; one re-key at a time;
- **bulk copy:** each new cell copies, once, the rows of its partitions from each old cell that feeds it (perf only, like the slot move's bulk copy);
- **cut-over:** once every new cell reports a committed copy, the catalog commits `cut(G)`; each old cell then commits `frz(G)` and from the moment it is in its log takes no write;
- **final copy:** once an old cell's freeze commits, each new cell it feeds copies its rows again with the dedup outcomes and the highest lock token per partition, and commits;
- **flip:** once every new cell holds its committed final copy from every source, the catalog commits `flip(G)`. A new cell takes writes only after the flip commits;
- **abandon:** before the flip, the workflow may be abandoned (a timer); old cells then thaw on the committed abandon. The catalog never flips once abandon is in its log, and never abandons once flip is.

**Positions** are `(generation, cell, log index)`. They never collide, but a cursor of one generation means nothing in the next. The two variants differ only there:
- **`rekey`** is CELL as written: a cell refuses a cursor of another generation (`unknown-log`), and the reader restarts from a snapshot of a flipped cell. A `state` reader is fine; a `log` reader loses its place, so P-07's "replay from any kept position" fails across a re-key.
- **`rekey-carry`**: the copy carries each record with its original position, and a new cell serves those too. A cursor of the old generation then continues, with no refusal. This is cheap lineage: positions compare as tuples, so `(1, 0, 5) < (2, 1, 0)`.

**What it leaves out:**
- Unclean recovery of any cell or of the catalog (as for every option here).
- The routing switch for reads (Vitess switches reads before writes). Reads here come from any cell's committed log, so there is nothing to switch.
- The reverse replication Vitess sets up so a re-key can be rolled back after the flip. Here there is no going back after the flip.
- Garbage collection of the old generation.

**Results** (model-checked; [../../results/rekey-ablation.json](../../results/rekey-ablation.json) and [../../results/rekey-carry-ablation.json](../../results/rekey-carry-ablation.json); every rule with its trace in [../../results/summary.md](../../results/summary.md)):
- **`rekey`: 35 of the 57 rules are necessary.** That is fixN's 13, plus 22:
  - one writer (4): a new generation writes only after its committed flip; an old cell takes no write once frozen; the final copy covers a committed freeze; the flip waits for committed final copies;
  - rows (3): carry the rows; one re-key at a time; copy from the current generation;
  - dedup and fence transfer (2): carry the outcomes and the highest token;
  - **cursor refusal (6):** refuse another generation's cursor; restart from a snapshot of a newer, flipped cell holding the partition;
  - progress (7): the six appends, plus "freeze only for a committed catalog decision".
- **`rekey-carry`: 29 of 51**, the same set without the six cursor rules. The copy carries each record with its position, and that costs no rule.
- **Not needed by any property:** the bulk copy and its ready report (the cut-over could start at once), and the whole abandon path, since a crash-only world never needs to give up.
- **Smaller with another order** (README finding 5): keep `freeze.rkcom` in place of `freeze.cutcom`, and the cut-over entry goes too: **34 rules** (`rekey-alt`, [../../results/rekey-alt-ablation.json](../../results/rekey-alt-ablation.json)). An old cell then freezes as soon as the catalog commits `rk(G)`, and the catalog needs no `cut` entry: four entry kinds (`rk`, `frz`, `cp`, `flip`), not five. All 34 rules are necessary alone, and `twice1` holds (1,015 states). Mutants: 43 of 52 caught, 8 equivalent swaps, 1 survivor (the same `restart.newer` flip). `freeze.rkcom` is needed for L7: without it an old cell can freeze for a re-key whose `rk` entry a catalog crash then loses, and stay frozen.
- **Mutants:** `rekey` 44 of 53 caught, 8 equivalent swaps, 1 survivor. The survivor lets a reader re-snapshot its own generation, which is wasteful but correct. `rekey-carry` 38 of 45 caught, 7 equivalent, none survived.
- **The give-up path, priced.** The catalog's `abandon` is pinned. Two runs:
  - `rekey+giveup` ([../../results/rekey+giveup-ablation.json](../../results/rekey+giveup-ablation.json)), greedy in model-text order: 45 kept, but 6 of them undecided at the state limit. Greedy met `copy.append` while `cut.ready` was still there, so the bulk copy looked needed, and that model was too big to settle `cut.ready`.
  - `rekey+giveup-alt` ([../../results/rekey+giveup-alt-ablation.json](../../results/rekey+giveup-alt-ablation.json)), warm-started without the bulk-copy path (`cut.ready`, `copy.append`, `copy.once`; every bound holds): **41 kept: the core 35, the pinned `abandon`, 4 rules the give-up needs, and 1 undecided** (`final.once`, "one final copy per source"). So re-key's give-up path costs **5 to 6 rules**. The 4, each with a counterexample:
    - **give up or finish, never both (2):** the catalog never flips once `abandon` is in its log (`flip.noab`), and never abandons once `flip` is (`abandon.noflip`). Without either, an old cell thaws after the flip: two writers (P6), in 16 steps;
    - **hand back (2):** an old cell thaws only on a **committed** abandon (`thaw.abcom`; else the abandon is lost in a catalog crash, the catalog flips, and the old cell has thawed: P6 in 16 steps), with a `thaw` entry (`thaw.append`, L5).
  - **Not needed:** "never cut over once abandoned" (`cut.noab`), "thaw only a cell that froze" (`thaw.frz`), and the idempotence guards.
  - The `twice1` verify of both runs stopped at the state limit with no counterexample (undecided): a re-key with a give-up path, two changes and a crash is more than 1.5 million states.
- **Why re-key's give-up is cheaper than the slot move's (11 to 13): one decider.** The catalog alone decides flip or abandon, so the exclusion "finish or give up, never both" is written once (2 rules). A slot move has two deciders, A before its fence (`cancel`) and B after it (`abort`), so it is written twice (4 rules), and B must also clean up after A's cancel. See the slot README for `slot+abort`, a slot move with one decider.
- **States:** as written, 67,182 (`grow`) to 312,298 (`shrink`) states, against 22,797 for slot moves. The smallest model has 1,443 to 4,417.
