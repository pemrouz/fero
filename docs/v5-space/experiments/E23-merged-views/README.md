# E-23: can live views over a resource held by several groups be merged exactly?

**Question (Q-23).** A v5 resource can be held by several groups (Raft groups that each own some of its 1,024 slots). Can live views (top-k, group, sum, filter) over the whole resource be built by merging each group's partial view, and does the merged view equal the one-group view after every commit, slot moves included?

**Short answer.** Two of the four views P-12 names merge exactly today; two do not.
- `filter` and `group` merge exactly (as values) at 1, 4, 16 and 1-to-16 elastic groups, through 7,201 slot moves and 1,199 view rebuilds, and at every cut of a merger that runs about 100 commits behind: 0 mismatches.
- `sum` merges exactly only while every value is an integer. With ordinary decimals, data's sum is a running total whose last bits depend on the order rows came and went, so it does not even equal its own query in one group, and a removed `NaN` row poisons it for ever.
- `top-k` (`za(col, k)`) merges exactly in its scores, but not in which tied rows it shows or their order: data breaks ties by arrival order, and no two groups, replicas or rebuilt views share one. In one more test, a column that mixes numbers and strings makes data's sorted index unsound even in one group: deleted rows stay in a top-10 for good (a data bug).
- With a small **merge contract** (ties broken by row key, an exactly rounded sum, a total order on values), all four merge exactly in every run here: 0 mismatches. The contract is built in this experiment from data's public API (a comparator view and a row sink), so it is a change of data's semantics, not new machinery.
- So, by Q-23's threshold: **data gains a merge contract** (a SCHEDULE_VERSION bump, planned now). A one-group ceiling would not save P-12 anyway: run B shows the same tie and float faults between two servers that each hold every group, and between a live view and a rebuilt one.

Evidence labels: **measured here** (the files in `results/`), **reasoned** (said where used), **cited** (two sources, linked where used).

## Words

- **Group:** a unit holding a log and one writer (a Raft shard). It owns a set of slots; a row's slot is a hash of its key.
- **Partial:** a group's own view over the rows it holds (for example its top 10).
- **Merger:** the code that combines the partials into one view (M). It applies the partials' changes at a **cut**: one set of positions, one per group.
- **L:** the same view over one data source that holds every row (the one-group result).
- **Q:** the query computed from scratch over the committed rows, by code that does not use data.
- **Exact:** equal as values: the same rows with the same contents (key order inside an output ignored), the same key sequence for an ordered view, the same bits for a number.
- **Tie-break:** the rule that orders rows whose sort values are equal.
- **Exact sum:** the sum of the multiset of values, rounded once (Shewchuk's algorithm, the one behind Python's `math.fsum`). It does not depend on order, so it merges.

## Method

All code is in `src/`, TypeScript run by Node 22.22.0 with `--experimental-strip-types`, against data at HEAD (`63fea66`, 2026-09-22, SCHEDULE_VERSION 4; `results/env.txt`). Records are fero's own (`{ type: 0|1|2, key: [row, ...path], value, at? }`), applied through data's hot `lane()`, as fero's `api/substrate.ts` applies them.

**Run A, merge exactness** (`src/merge.ts`). One resource with 1,024 slots and G groups. Each group is a data source with its own views (the partials). For every operator, three outputs are compared after **every** commit: the merged view M, the one-group view L, and the pure query Q. 100,000 random commits per run:
- single-row writes (insert, overwrite, field update, field delete, row delete) over 3,000 keys (about 1,000 to 2,000 live rows), and 5% multi-row commits inside one group;
- slot moves (1 in 250 steps): 1, 8, 64 or 256 slots at once from one group to another; the rows leave A's fold and enter B's in one data commit, and the merger applies both at one cut (the design's rule "a server takes each slot from exactly one of A and B", DESIGN-V5 §4.2);
- `elastic`: start at 1 group; a grow moves a random half of a group's slots to a new group, a shrink moves all of a group's slots to another and deletes it (up to 16 groups);
- mix `failover`: also, 1 in 1,000 steps, one group's views are thrown away and rebuilt from its rows (a new leader building its views), and the merger resyncs from the new partial.
- Configurations: G = 1, 4, 16, elastic; domains `int` (scores 0 to 100: many ties), `float` (two-decimal values, wide values and tiny values), `dirty` (mostly integers, with decimals, `null`, missing fields, numeric strings like `'42'`, the string `'x'`, and rare `NaN` and infinities); mixes `moves` and `failover`. 24 runs.
- Operators: every data operator P-12 needs and its neighbours: `filter`, `za('points', 10)` (top-k), `limit(10)`, `sum`, `length`, `avg`, `max`, `min`, `some`, `every`, `median`, `group(room)`, `length(room)` (counts per bucket), `distinct(room)`. Each has a "data" merge (what a merger can do with what data's view exposes today) and, where today's is not exact, a "C" (contract) partial: `topkC` = `az(cmpTotal, 10)` with ties by row key, `sumC`/`avgC` = an exact sum per group as a row sink, `maxC` = max over numbers only, `medianC` = each group's whole sorted column, `countByC` = counts with empty buckets dropped, `distinctC` = the representative of the smallest row key.
- Cadence: scalars and ordered views at every commit; rows and buckets at every commit for the touched keys and buckets, and in full every 1,000 commits, after every move, grow, shrink and rebuild, and at the end; `median` and `distinct` every 100 commits and after every event.

**Run B, history independence** (`src/interleave.ts`). A merge can only be exact if each view is a function of the committed rows, not of their history. Two "full followers" fold the same commits of G = 4 or 16 groups; F2 keeps each group's own order but interleaves the groups differently (TEST-12's shuffle). Every 200 commits F2 catches up and every view of F1 and F2 is compared. Every 2,000 commits, F1's live views are also compared with fresh views over the same source (a rebuild) and with views over a fresh source loaded from F1's rows in key order (a follower that starts from a snapshot). Each comparison is done as values and as bytes (data's own output order). 100,000 commits for `int` and `float`; 20,000 for `dirty` (see the fault below).

**Run C, a move seen as two cuts** (`src/merge.ts --move=fence-first|open-first`). As run A, but the merger sees A's fence (rows leave A) and B's open (rows enter B) at two different cuts, and every view is checked between them.

**Run D, cost** (`src/bench.ts`, under `$SP/bin/timing`, 3 runs each). 200,000 timed commits (after 20,000 warm-up) through: one source with the view; 16 group sources with no views; 16 with the partials; 16 with partials and the merger; and the contract partials and merger for top-k and sum.

**Run E, a merger that lags and interleaves** (`src/async.ts`). Run A checks cuts where every group is current; a real merger hears from each group late, over its own link. Here each group's partial changes for each commit queue up in that group's order; the merger takes 0 to 2 per commit from random groups (so it lags by a random walk), and a slot move is one delivery that must head both groups' queues (the pairing rule). After every delivery, the merged `filter`, `group`, `za` top 10, `topkC`, data's `sum` and `sumC` are compared with the query over exactly the rows of the merger's cut. G = 4 and 16, int and float, 100,000 commits each.

**Checks of the checks.** The exact sum matches Python's `math.fsum` (an independent C implementation) on 2,000 random cases, bit for bit, and gives the same bits after values are added and removed in shuffled orders and after 4 partials are merged (`results/exactsum-check.txt`). The benchmark's merged sum and top-10 are compared with the truth after each timed run (`sanity: ok`). The truth fold, the queries and the comparisons do not use data.

To re-run: `./run.sh all` (about 2.5 CPU-hours: about 1 hour of wall time at three runs at a time, plus waits for the locks), or one part: `./run.sh A 16`, `./run.sh B`, `./run.sh C`, `./run.sh E`, `./run.sh D`, `./run.sh checks`, then `./run.sh S` for the tables. `SKIP_DONE=1` resumes a part. `./fetch.sh` checks that data is at the commit used; nothing is downloaded.

## Results

### 1. Run A: what merges exactly (measured here)

24 runs of 100,000 commits: 225,612,481 checks in all. M = merged, L = one group, Q = the query over the rows. A cell is the share of checks that differed, summed over every configuration of the domain (G = 1, 4, 16 and elastic; mixes `moves` and `failover`). "0" means exact at every check. The full tables, per configuration, are in [results/summary.md](results/summary.md); the raw files are `results/A-*.txt`.

| view | merge rule (data as is) | int | float | dirty | contract version, all domains |
|---|---|---|---|---|---|
| `filter` | union of rows by key | 0 | 0 | 0 | (already exact) |
| `group(room)` | union of members per bucket | 0 | 0 | 0 | (already exact) |
| `length` | add | 0 | 0 | 0 | (already exact) |
| `some`, `every` | or, and | 0 | 0 | 0 | (already exact) |
| `max`, `min` | larger, smaller | 0 | 0 | M≠L 17% (`max`), 0.8% (`min`) | `maxC`, numbers only: 0 |
| `sum` | add the groups' sums | 0 | M≠Q 97%, L≠Q 99.4% | M≠Q 0.013% (a `NaN` that left) | `sumC`, exact sum: 0 |
| `avg` | weight each group's average by its row count | M≠Q 0.024% | M≠Q 97% | M≠Q 0.016% | `avgC`, (exact sum, count): 0 |
| `za('points', 10)` (top-k) | each group's top 10, re-sorted | scores 0; set 95% and order 99.5% at G > 1 | 0 (few ties) | scores 99% | `topkC`, ties by key: 0 |
| `length(room)` (counts) | add per bucket | M=L 0; L≠Q 0.017% (empty buckets kept) | the same | the same; after one rebuild the merged view also lacked empty buckets the one-group view kept (328 checks) | `countByC`, empty buckets dropped: 0 |
| `distinct(room)` | union; first representative to arrive | 0 | 0 | M≠L 3.3% (`1` or `'1'`) | `distinctC`, smallest key: 0 |
| `median` | median of the groups' medians | M≠Q 57% | 79% | 65% | `medianC`, whole columns: 0 |
| `limit(10)` | union, first 10 by arrival | 0 at G = 1; 99% at G > 1 | 99% at G > 1 | 99% at G > 1 | not mergeable |

What the table says, in plain words:
- **Exact today, everywhere:** `filter`, `group`, `length`, `some`, `every`, and `max`/`min` while the column holds only numbers. Moves (7,201 slot moves, 1,013,022 rows moved), groups coming and going (1,177 grows, 1,145 shrinks) and view rebuilds (1,199) never broke them.
- **`sum` is exact only for integers.** With decimals, data's own one-group `sum` differs from the exactly rounded sum of the same rows at almost every check (`sum L=Q`), so no merge can match it. A rebuild changes it too: at G = 1 with rebuilds, the rebuilt sum and the never-rebuilt one disagree from the first rebuild on. The errors are in the last bits (for example `155.2` against `155.20000000000002`), but they break every equality check fero relies on (P-16, DATA-01, TEST-10). In the dirty domain, a `NaN` row that has left keeps the sum `NaN` (`sum L=Q`, 0.013% of checks).
- **`avg`** cannot be merged from what data shows (only the average): weighting by row count still misses bits even on integers. With (exact sum, count) as the partial (`avgC`) it is exact.
- **`top-k` (`za`)**: the scores always agree (int, float), but which tied rows are shown, and in what order, does not: at G > 1 the merged top 10 holds a different set of rows than the one-group top 10 in 95% of checks (int domain). Even at G = 1, a relay that re-applies `za` to the rows it was sent orders ties differently from the source (`topk M=L order` at G = 1). With ties broken by row key (`topkC`), merged, one-group and query agree at every check in every domain.
- **dirty domain:** data's `max`, `min` and `za` give different answers for the same rows depending on order when strings mix with numbers, and `distinct` shows `1` or `'1'` depending on which came first. The contract versions are exact.
- **`median`**: the median of the groups' medians is wrong in 83% of checks at G > 1. Merging the whole sorted columns (`medianC`) is exact, at the cost of sending every value.
- **`limit(10)`**: exact at G = 1 only. At G > 1 the merged "first 10" differs in about 99% of checks: there is no shared arrival order to merge.
- **`length(room)` counts**: merge exactly against L, but data keeps a bucket at `{ value: 0 }` after its last row leaves, which is not the query (0.02% of checks); a group that is removed or rebuilt drops its zero buckets (dirty and failover runs). Pruned counts (`countByC`) are exact.

### 2. Run B: which views depend on history (measured here)

Each cell: comparisons that differed / comparisons made. "interleave" = two servers that fold every group, interleaved differently; "rebuilt" = a fresh view on the same source; "snapshot" = a fresh source loaded from the rows in key order.

| view | int: interleave | rebuilt | snapshot | float: interleave | rebuilt | snapshot | dirty: interleave | rebuilt | snapshot |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| avg | 0 | 0 | 0 | **992/1002** | **100/102** | **102/102** | 0 | 0 | 0 |
| az(points) full order | **996/1002** | 0 | **102/102** | **15/1002** | 0 | **102/102** | **202/202** | **22/22** | **22/22** |
| distinct(room) | 0 (bytes 1002/1002) | 0 (bytes 102/102) | 0 (bytes 102/102) | 0 (bytes 1002/1002) | 0 (bytes 102/102) | 0 (bytes 102/102) | 0 (bytes 202/202) | 0 (bytes 22/22) | **21/22** |
| every | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| filter | 0 (bytes 1002/1002) | 0 (bytes 102/102) | 0 (bytes 102/102) | 0 (bytes 1002/1002) | 0 (bytes 102/102) | 0 (bytes 102/102) | 0 (bytes 202/202) | 0 (bytes 22/22) | 0 (bytes 22/22) |
| group(room) | 0 (bytes 1002/1002) | 0 (bytes 102/102) | 0 (bytes 102/102) | 0 (bytes 1002/1002) | 0 (bytes 102/102) | 0 (bytes 102/102) | 0 (bytes 202/202) | 0 (bytes 22/22) | 0 (bytes 22/22) |
| length | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| length(room) counts | 0 (bytes 1002/1002) | 0 (bytes 102/102) | 0 (bytes 102/102) | 0 (bytes 1002/1002) | 0 (bytes 102/102) | 0 (bytes 102/102) | 0 (bytes 202/202) | 0 (bytes 22/22) | 0 (bytes 22/22) |
| limit(10) | **135/1002** | 0 | **102/102** | **116/1002** | 0 | **102/102** | **61/202** | 0 | **22/22** |
| max | 0 | 0 | 0 | 0 | 0 | 0 | **1/202** | **3/22** | **7/22** |
| maxC (numbers only) | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| median | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| min | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| some | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| sum | 0 | 0 | 0 | **993/1002** | **100/102** | **102/102** | 0 | 0 | 0 |
| topk za(points,10) | **28/1002** | 0 | **102/102** | 0 | 0 | 0 | **200/202** | **22/22** | **22/22** |
| topkC az(cmpTotal,10) | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

What the table says:
- **As values, most views are functions of the rows:** `filter`, `group`, counts, `length`, `some`, `every`, `min`, `median`, `maxC` and `topkC` never differ, in any domain, under any of the three. In the dirty domain `max` (`'x'` against `Infinity`) and `distinct` (`1` against `'1'`) do.
- **As bytes, every rows-shaped view differs** (`filter`, `group`, `distinct`, counts): data lists rows in the order they reached the view, so two servers, a rebuild, or a snapshot follower list the same rows in a different order. P-16's "byte for byte" cannot hold for them as data stands.
- **Ties by arrival** (`za` top-k, `az` full order, `limit`) differ between two servers that fold the same groups, and always differ on a follower that starts from a snapshot. A rebuilt view on the same source happens to agree (it rebuilds in the source's own order), except in the dirty domain, where the sorted index is unsound (part 3).
- **Float `sum` and `avg`** differ under every one of the three, in about 99% of comparisons.

### 3. A data fault: sorted views over a column that mixes numbers and strings (measured here)

One source, one writer, no groups (`src/probe-mixed.ts`, `results/probe-mixed.txt`). 20,000 random upserts and removes over 2,000 keys:

| column values | deleted rows shown in the top 10, summed over 20,000 writes | deleted rows shown in the full order | most index entries beyond the live rows (about 1,500) | first deleted row shown at write |
|---|---:|---:|---:|---:|
| numbers only | 0 | 0 | 0 | never |
| numbers, plus `null`, `NaN` or missing | 0 | 0 | 0 | never |
| strings only | 0 | 0 | 0 | never |
| numbers, plus 1% numeric strings (`'42'`) | 0 | 24,361,146 | 12,317 | 494 |
| numbers, plus 1% `'x'` | 11,781 | 22,781,648 | 11,551 | 493 |
| numbers, plus 0.1% `'x'` | 5,473 | 23,125,593 | 11,922 | 2,006 |

The counts are deterministic (the same in two runs). The recorded run took 5 to 9 s for the sound cases and 69 to 156 s for the broken ones, three jobs at a time on a shared box: a sign of the growing index, not a timing measurement.

When even 0.1% of a column's values are strings, `az`/`za` stop being sound: deleted rows stay in the view (thousands of times in the top 10 alone), and the index keeps up to about 12,000 stale entries beside about 1,500 live rows, so every change costs more as it grows. The cause is the comparator: `va < vb` across types is not a strict weak order (`9 < '10'` and `'10' < '9'`), so the index's binary search cannot find a key to remove it. Numbers mixed with `null`, `NaN` or missing values are fine (they sort last by an explicit rule). This is a bug in one group, independent of merging; part 2 of the contract fixes it.

### 4. Run C: a slot move seen as two cuts (measured here)

`results/C-*.txt`, 20,000 commits each, int domain; G = 4 (78 moves, 8,818 rows moved) and elastic (69 moves, 37,600 rows, 35 grows, 34 shrinks). Each cell: checks at the cut between the two halves that differed / checks made there. Full table: [results/summary.md](results/summary.md).

| view, at the cut between the halves | fence first, G = 4 | fence first, elastic | open first, G = 4 | open first, elastic |
|---|---:|---:|---:|---:|
| `filter`, row count | 70 / 78 | 69 / 69 | 0 / 78 | 0 / 69 |
| `group`, buckets | 1,866 / 3,894 | 3,328 / 3,440 | 0 / 3,894 | 0 / 3,440 |
| `length` | 76 / 78 | 69 / 69 | 76 / 78 | 69 / 69 |
| `sum` and `sumC` | 76 / 78 | 69 / 69 | 76 / 78 | 69 / 69 |
| counts per bucket (`countByC`) | 1,866 / 3,894 | 3,328 / 3,440 | 1,866 / 3,894 | 3,328 / 3,440 |
| `topkC`, set | 30 / 78 | 64 / 69 | 0 / 78 | 0 / 69 |
| `medianC` | 18 / 78 | 36 / 69 | 14 / 78 | 29 / 69 |

(Moves of empty slots change nothing, hence 76 of 78.)

When the merger applies A's fence and B's open at different cuts, the cut between them is wrong: with the fence first, rows of the moving slots are missing from every view (filter, group, counts, sums); with the open first, rows are counted twice in sums, counts and medians. Row unions survive the open-first order, because the merger holds each key from exactly one group (rule 2 below), but nothing survives fence-first. After the second half lands, every view is exact again. So the merger must apply both halves at one cut.

### 5. Run E: a merger that lags and interleaves (measured here)

`results/E-*.txt`, 100,000 commits each. Each cell: deliveries at which the merged view differed from the query over the merger's cut / deliveries checked.

| run | deliveries | merger lag, mean (max), in commits | `filter` | `group` | `topkC` | `sumC` | data's `za`, order (scores) | data's `sum` |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| G = 4, int | 99,940 | 110 (380) | 0 | 0 | 0 | 0 | 99,824 (0) | 0 |
| G = 16, int | 99,885 | 102 (354) | 0 | 0 | 0 | 0 | 99,843 (0) | 0 |
| G = 4, float | 99,922 | 108 (373) | 0 | 0 | 0 | 0 | 0 (0) | 96,860 |
| G = 16, float | 99,863 | 98 (340) | 0 | 0 | 0 | 0 | 0 (0) | 97,405 |

The merger took the groups' partial changes late (a mean lag of about 100 undelivered commits) and in a random order across groups, with moves applied as one paired delivery. At every delivery, `filter`, `group`, `topkC` and `sumC` equal the query over exactly the rows of the merger's cut. So "after each commit" holds as "at each cut".

### 6. Run D: what merging costs (measured here, timing)

One hold of the CPU lock for the whole series (`$SP/bin/timing`), 1-minute load 1.7 to 2.4 inside it; 16 groups, int domain, 200,000 timed commits per run, 3 runs per row; ns per commit, median (spread = max − min). Raw: `results/D-bench.txt`; summary: `results/D-bench-summary.txt`. Every merged run's sum and top 10 were checked against the truth afterwards (`sanity: ok`).

| view | one group, with the view | 16 groups, partials only | partials + merger | merger's cost per commit | per partial change it applied |
|---|---:|---:|---:|---:|---:|
| (no views: 16 folds) | | 1,212 (113) | | | |
| `filter` | 1,501 (499) | 1,366 (378) | 2,697 (210) | +1,331 | 2.1 µs (0.63 changes per commit) |
| `za('points', 10)` | 4,567 (295) | 3,917 (520) | 4,538 (397) | +621 | 2.3 µs (0.27) |
| `topkC`: `az(cmpTotal, 10)`, ties by key | | 3,593 (337) | 4,434 (796) | +841 | 3.1 µs (0.27) |
| `sum` | 1,451 (44) | 1,429 (96) | 1,837 (257) | +408 | 0.46 µs (0.88) |
| `sumC`: the exact sum, as a row sink | | 1,586 (113) | 1,884 (202) | +298 | 0.34 µs (0.89) |
| `group(room)`, merged as bucket objects | 15,186 (995) | 6,058 (909) | 52,356 (1,646) | +46,298 | 37 µs (1.26) |

- **The contract costs little.** The key tie-break costs nothing measurable (`topkC` partials 3,593 against `za` 3,917, inside the spreads). The exact sum costs about 0.16 µs more per commit than data's running total (1,586 against 1,429, more than either spread).
- **Merging sums is cheap** (0.3 to 0.5 µs per change). **Merging rows costs about 2 to 3 µs per change** here, mostly data's own fixed cost of one more commit at the merger (one lane write and flush; 16 folds with no views cost 1.2 µs per commit). This merger drains after every commit, the worst case; one that applies a frame of changes at a time pays it once per frame (reasoned).
- **`group` must not be merged as bucket objects.** data emits a whole bucket (about 40 rows here) for each change, so the merger rebuilds one per change: 37 µs. Merging `group` as rows (forward the rows, group at the merger, about the one-group cost) or streaming bucket members as row changes (DESIGN-V5 §4.5 already lists "a `group` bucket can be streamed (a data change)") avoids it (reasoned).
- **A side observation on P-12's bar** (≤ 1 µs per affected view per change): on this box data's own `za` costs about 3.4 µs per commit over a bare fold (4,567 − about 1,200) and `group` about 14 µs, both above the bar, in one group, with no merging. That is data's perf pin, not E-23's question; it is reported for the owner of P-12's perf rows.

## What it means

### For data: a merge contract

Every fault above is the same fault: a view's output depends on the order rows arrived in, or on when the view was built, not only on the rows. One group hides that on a writer that folds its own log in order. Several groups, a follower started from a snapshot, a rebuilt view, or a relay that re-applies an operator do not. So the fix is one rule in data, with six parts (measured as a fix here where marked; the rest reasoned):

1. **Ties break by row key, never by arrival,** in `az`, `za` and `top` (measured: `topkC` is exact in every run). `limit(n)` and `reverse()` order by arrival by definition, so they are marked not mergeable.
2. **One total order across value types** for column comparisons: numbers that are not `NaN`, then strings, then the rest, with `undefined`, `null` and `NaN` last as today. Measured in the simpler form `cmpTotal` uses (numbers first, every other value after them, ties by row key: `topkC`, `maxC`); ordering strings among themselves is reasoned. This also removes the sorted-index fault: a binary search needs a comparator with no cycles, and `9 < '10' < '9'` is a cycle.
3. **`sum` and `avg` are exactly rounded,** with `NaN` and the infinities counted, so a sum is a function of the current values and a removed `NaN` stops poisoning it (measured: `sumC`, `avgC`; the method is Shewchuk's exact partials [cited: Shewchuk, "Adaptive Precision Floating-Point Arithmetic and Fast Robust Geometric Predicates", 1997, https://doi.org/10.1007/PL00009321; Python's `math.fsum`, https://docs.python.org/3/library/math.html#math.fsum] and matches `math.fsum` bit for bit here).
4. **`distinct` exposes the value of the smallest row key** that holds it, not the first to arrive (measured: `distinctC`).
5. **`length(fn)` counts drop empty buckets,** or the docs say that a zero bucket is history and is not kept across groups, rebuilds or snapshots (measured: `countByC`).
6. **Each operator states its merge** in `exportContract()`: `rows` (union by key: `filter`, `gt`/`lt`/`gte`/`lte`, `between`, `map`, `keys`, `values`, `group`), `add` (`sum`, `length`, `avg` as (sum, count), counts), `extreme` (`max`, `min`), `bool` (`some`, `every`), `window` (each partial's top n, k-way merged: `az`/`za`/`top` with n), `column` (exact only from every value: `median`, `quantile`, `percentile`, `az`/`za` without n), `none` (`limit`, `reverse`, `reduce` without a user merge, `to`). Set operators between two views of one resource are `rows` (both sides are split by the same row key); across two resources they need both on one process (reasoned, not run).

These are behaviour changes of data's operators, so they go in a new numbered SCHEDULE clause with its own conformance tests, and `SCHEDULE_VERSION` goes up by one in both repos (DATA-04). Plan it now: run B shows the faults between replicas of one group too, so the change is needed whatever the group count.

### For fero: the merger (layer L4)

The merger is small. Rules 1 to 4 were exercised here; rule 5 is reasoned:
1. **A merged view is defined at a cut,** each group at one committed position. There is no order across groups (TEST-12), so "after each commit" becomes "at each cut". Run E measures this with a merger that lags and interleaves.
2. **Each key from exactly one group.** A row removed by a group that no longer owns its key is ignored. This is the design's "views mid-move" rule (DESIGN-V5 §4.2), moved to the merger.
3. **Pair the two halves of a slot move.** The partial changes a move causes carry the move's name, and the merger applies A's fence and B's open at one cut. Run C shows what goes wrong without it.
4. **Resync a rebuilt partial** (a failover) from its snapshot through data's snapshot-then-deltas (clause 7): run A's `failover` mix.
5. **Operators marked `none`** over a resource that no process folds whole throw `holistic`; `column` operators gather every value (the v4 gather, O(rows)), and the page says so.

Rules 2 to 4 keep in-memory state only (no log, no replicated state), so by DEV-10's letter they are not a new mechanism; they are the published partial-aggregate pattern: distributive, algebraic and holistic aggregates [cited: Gray et al., "Data Cube: A Relational Aggregation Operator Generalizing Group-By, Cross-Tab, and Sub-Totals", 1997, https://doi.org/10.1023/A:1009726021843]. data's own operator categories (`aggregate-decomposable`, `holistic`) already echo it. Rule 3 reads the move entries the slot-move protocol already writes.

### For the requirements and API.md

- **P-12's acceptance test** compares merged partials with "the one-group result". Today the one-group result itself depends on history (ties, float sums), so the test must compare with the query over the rows (Q), as values.
- **P-16's "byte for byte"** holds only when a rebuild replays the same records in the same order into views built before the first record. A view built on a snapshot, or a replay that interleaves groups differently, differs in key order for every rows-shaped view, and in value for ties and float sums (run B). The test should compare as values, or data must enumerate outputs in key order.
- **SC-10** gains one stated ceiling: an operator marked `none` (or an exact `column` operator, unless the gather is paid) needs one process that folds every group, so it is bounded by rows per process (about 1e6 small rows on Node's default heap, SC-10).
- **TEST-12's shuffle** will expose any app that leans on data's arrival tie-break today; with the contract, the shuffle cannot change a mergeable view (run B).

### What API.md must change

- **P-12's guarantee** ("A view equals its query over the committed state after each commit ... Across groups, views merge by partials (Q-23)") should read: a view equals its query over the committed rows, as values, at every cut it applies (each group at one committed position; a slot move applied as one cut). Ties in ordered views break by row key; `sum` and `avg` are exactly rounded. Across groups, the operators data marks mergeable merge by partials; `limit`, `reverse` and `reduce` without a merge function throw `holistic` over a resource that no process folds whole, and exact quantiles gather every value.
- **P-16's guarantee** ("byte for byte") should read "equal as values", unless data also promises key-ordered output.
- **The `holistic` error** (API.md's errors table) also covers an operator marked not mergeable over several groups.
- No call or type changes: the merge is inside fero and data. The `Ops` and `View` types stay data's (DATA-05).

## What this box cannot show

- **Real links.** The merger here is in the same process as the groups; run E simulates late and interleaved delivery with a seeded scheduler, not with sockets. Wire bytes per partial change are not measured (a filter or top-k change is one row; a `group` change today is a whole bucket; a sum change is two numbers).
- **Scale.** About 2,000 live rows, 50 buckets, top 10, up to 16 groups. Costs of bigger windows, many more groups, or millions of rows are not measured; the merge rules do not depend on size, but the costs do.
- **Timing quality.** Run D ran under the CPU lock with a 1-minute load of 1.7 to 2.4 inside it (the box's other agents and the lock's own churn), on one 4-vCPU VM. Differences smaller than the spreads in its table are not claims.

## Gaps

- **data's version.** This ran against data at `63fea66` (2026-09-22, `SCHEDULE_VERSION` 4), the HEAD in `/home/user/pemrouz/data`. fero v4's `api/substrate.ts` already cites data's SCHEDULE clause 4 at VERSION 5, so a newer data exists elsewhere. Also, the path fero imports data from (`/home/user/data`) does not exist on this box, so fero's own suite cannot run here as checked in. The probe (`src/probe-mixed.ts`) and runs A and B are one command each; re-run them on the newer data before the contract is written.
- **Operators not run:** `between`, `map`, `keys`, `values`, the set operators, `quantile`/`percentile` (same code as `median`), `reduce`, `to`, `tap`, and reactive arguments. Their merge rules above are reasoned. A reactive argument (a bound that is itself a view) must reach every group at one cut, which is the same pairing problem as rule 3 (reasoned).
- **The contract is emulated,** not built into data: `topkC` uses data's comparator form (which data does not share between equal views, DATA-05), and `sumC`, `avgC`, `countByC`, `distinctC`, `medianC` are row sinks outside data. Built into data, the costs should be close to run D's (reasoned).
- **Run C's pairing is reasoned to be enough;** the harness shows both halves at one cut are exact (run A) and either order alone is not (run C), but the move-name tagging of partial changes is not built.
- **Run B's dirty domain** ran 20,000 commits, not 100,000: data's sorted-index fault makes it slow quadratically.
- No tool was downloaded. Python 3 was used only to cross-check the exact sum with `math.fsum`.

## Files

- `src/lib.ts`: the slot hash, the canonical printer, the exact sum, the row generator, the independent fold.
- `src/merge.ts`: runs A and C. `src/interleave.ts`: run B. `src/async.ts`: run E. `src/bench.ts`, `src/bench-all.sh`, `src/bench-summary.ts`: run D. `src/probe-mixed.ts`: the sorted-index fault. `src/exactsum-check.ts` with `src/check_fsum.py`: the exact-sum cross-check. `src/summarize.ts`: the tables. `src/par.sh`: runs a part's commands three at a time under one hold of the heavy lock.
- `run.sh`: every part (see its header). `fetch.sh`: checks data's commit; downloads nothing.
- `results/`: `env.txt`; `A-*.txt` (24), `B-*.txt` (6), `C-*.txt` (4), `E-*.txt` (4) raw outputs; `summary.md` (run A and C tables); `D-bench.txt`, `D-bench-summary.txt`; `probe-mixed.txt`; `exactsum-check.txt`.

## Verdict

Q-23: Not today, yes with a merge contract in data. `filter`, `group`, `length`, `some`, `every` and numeric `max`/`min` already merge exactly across 1 to 16 groups with slot moves, grows, shrinks and failovers (0 mismatches in 225.6 million checks, and at every cut of a lagging merger), but `top-k` (ties by arrival) and `sum` (a float running total; `NaN` poisoning) do not, even between replicas of one group, and a column that mixes numbers and strings breaks data's sorted index; ties by row key, an exactly rounded sum and one total order on values make all four exact at a cost of about 0.2 µs per commit, and fero's merger needs four rules (a cut, one owner per key, paired move halves, resync on rebuild). Moves: MIN, DRAFT, CELL, LANE, SPLIT and MIN's variants up on P-12 (no one-group ceiling needed for the views it names), conditional on the contract; every candidate equally (no ranking change) down on DATA-01, DATA-04, DATA-05 and P-16 until data's contract lands (a SCHEDULE_VERSION bump, planned now); SC-10 gains one stated ceiling (`limit`, `reverse`, `reduce` and exact quantiles need one process that folds every group).

