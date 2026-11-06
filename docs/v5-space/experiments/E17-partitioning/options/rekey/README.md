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

**Results:** see the E-17 [README](../../README.md) and [../../results/summary.md](../../results/summary.md).
