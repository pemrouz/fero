# E-06: fork and rewind for fero test

**Question (Q-06).** Can `data` fork and rewind state cheaply enough for fero test? TEST-06 says a fork costs a record, not a copy. TEST-07 says any recorded input can be re-run on the exact state just before it, in ≤ 10 ms each (so 100 reruns take ≤ 1 s; T's spike took about 100 s for 387). The question decides TEST-06 and TEST-07 for every candidate, and whether `data` needs shared-structure state, a data-side change to plan now (DATA-04).

**Threshold (QUESTIONS.md).** A rerun ≤ 10 ms at the café's size (fero test's example) and ≤ 100 ms at 1e6 rows → no data change. Above → data gains structural sharing (planned now), or fero test states its limit.

**The café's size.** T's café ("fero test", the artifact cited in REQUIREMENTS as T) is one `bookings` resource: a few slots and one row per booking. Its week of recorded traffic is 1,904 inputs, and its replay test reran 1,191 inputs from 50 sequences. So its state is at most a few thousand rows; the table's 1e3 rows stand for it (reasoned from T's numbers, not measured on the café itself).

## Method

Everything goes through fero v4's real seam ([tree.sh](tree.sh): `api/substrate.ts` and `kernel/env.ts` from fero 68a5b8e, data 63fea66 linked beside them; nothing in fero or data is changed). The persistent map is **Immutable.js 5.1.9** from npm ([fetch.sh](fetch.sh) checks npm's sha512 integrity): its `Map` is a hash array mapped trie, so a copy shares all but the changed path. Code in [bench/](bench).

- **The resource.** n small rows (~100 B each, as E-05) loaded through the seam as a replica loads them (fero frames decoded, folded by the lane). Most runs have no view; one variant per size has one `group` view with a sink, because E-05 found that view costs O(rows per bucket) per commit.
- **The tape.** 20,000 recorded inputs (fewer where noted), each two records like a booking call: a field update of one row and a whole-row rewrite of another. No input adds rows, so the state stays at n rows. Inputs fold one record at a time through `substrate.applyRec`, as fero v4 folds commits.
- **Copy (fork)** ([bench/fork.mjs](bench/fork.mjs)): data's dense snapshot (`substrate.snapshot`, a fresh object whose rows are shared by reference, since data's rows are immutable once written); data adopting that object as a new source (`substrate.proxy`); the fork's first field update; its first new row (data then builds its key map: its one-shot "promote"); building the fork's `group` view; all of these together (`fork-total`, a fork ready to run the resource's code); a refill through the lane instead; a deep copy (`structuredClone`); an Immutable.js `Map` of the rows, a fork of it (keep the pointer, then one `set`), and turning it back into an object data can adopt. Each timed 5 times in the process, heap collected before each; the median is reported. Also the heap one ready fork holds.
- **Rerun** ([bench/rewind.mjs](bench/rewind.mjs)): get the state just before input i, apply input i's two records, read back the row it wrote. 20 inputs are sampled at random (5 for the slow `group` variants at 1e5 and 1e6 rows). Four ways:
  - `snap`: every K inputs (K = 100, 1,000, 10,000) keep data's dense snapshot; a rerun copies the nearest one (data writes into an object it adopts, so the kept one cannot be handed over as it is), adopts the copy, builds the view if any, replays the inputs since the snapshot, then runs input i. At most ten snapshots are kept (the tape is 10 × K inputs, at least 2 × K).
  - `imm`: the same, but the kept states are Immutable.js maps updated beside data on every record, so taking a snapshot is keeping a pointer; a rerun turns the nearest map back into an object for data (`toObject`).
  - `immfloor`: no data at all: the state is an Immutable.js map with a version kept per input, and a rerun is the version before i plus two `set`s. This is the floor a data store that shares structure could reach.
  - `undo`: no snapshots. While the tape is walked in order, input i is applied, its row read back, and its records undone by their inverses (each inverse read from the row just before its record lands: the old field value, the old row, or a remove of a row the record created), then input i is applied for real. Every one of the first five reruns at 1e3 and 1e5 rows compares the whole state after the undo with the state before (all equal) and checks the key order; one extra rerun undoes a row removal.
- **Timing.** One `$SP/bin/timing` hold per run, 3 runs, every process well under 60 s and preceded by its load average. Run 1 used the default 2 GB heap and stopped at 1e6 rows (`fork.mjs` ran out of memory holding the parent, a fork, a deep copy and an Immutable map at once); runs 2 and 3 ran with `--max-old-space-size=6144`, and run 1's 1e6 part was run again with it on 2026-11-08, after a usage stop (its first, out-of-memory attempt left one load line with no result after it, `results/fork.jsonl` line 5). Tables give the median of the runs and, in brackets, the spread (lowest and highest run). Machine: 4 vCPU, 16 GB, Linux 6.18 (Firecracker VM), Node 22.22.0 (V8 12.4).

To reproduce: `./fetch.sh`, `./run.sh`, then `python3 summarize.py`.

## Results

Raw lines: [results/fork.jsonl](results/fork.jsonl) and [results/rewind.jsonl](results/rewind.jsonl).

<!-- tables:start (python3 summarize.py) -->

### fork: ms to copy a resource (median of 5 in a process; median of runs, spread of runs)

| rows | snapshot | adopt | first-update | first-insert | view | fork-total | lane-refill | deep-copy | imm-build | imm-fork | imm-to-data | fork heap MB | fork B/row | Immutable map MB |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1,000 | 0.362 (0.357-0.444) | 0.040 (0.038-0.040) | 0.223 (0.197-0.278) | 0.419 (0.405-0.541) | 1.11 (0.89-1.23) | 1.58 (1.46-1.91) | 0.832 (0.776-0.874) | 1.35 (1.19-1.35) | 1.27 (1.05-1.41) | 0.052 (0.049-0.053) | 0.352 (0.304-0.396) | 0.200 (0.200-0.200) | 251.0 (251.0-251.0) | 0.200 (0.200-0.200) |
| 100,000 | 37.8 (36.4-39.1) | 0.095 (0.076-0.096) | 0.203 (0.180-0.220) | 44.2 (43.3-44.7) | 117.8 (108.0-119.8) | 170.1 (157.9-172.8) | 64.0 (58.9-66.3) | 277.8 (266.5-288.0) | 57.7 (55.7-58.8) | 0.081 (0.074-0.086) | 37.3 (34.8-47.2) | 28.5 (28.5-28.5) | 299.0 (299.0-299.0) | 14.8 (14.8-14.8) |
| 1,000,000 | 514.9 (473.9-569.9) | 0.082 (0.082-0.104) | 0.259 (0.223-0.262) | 690.9 (681.8-723.4) | 1,810 (1,703-1,863) | 2,632 (2,461-2,770) | 1,009 (961-1,079) | 4,616 (4,465-4,633) | 1,261 (1,257-1,301) | 0.085 (0.073-0.114) | 716.7 (651.3-817.2) | 235.5 (235.5-235.5) | 247.0 (247.0-247.0) | 154.5 (154.5-154.5) |

load average at start of each process: median 1.38, range 0.26-2.00, n=10

### rerun one input on the exact state before it (ms per rerun: median of the 20 (or 5) sampled reruns per run; median of runs, spread of runs)

| rows | method | K | view | rerun median | rerun p90 | rerun max | inputs replayed (median) | snapshots kept | ms to take one | heap kept MB | µs per record to keep | runs |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1,000 | snap | 100 | none | 0.607 (0.521-0.685) | 1.07 (0.77-1.25) | 1.19 (1.05-1.52) | 48 | 10 | 0.509 (0.442-0.542) | 0.600 (0.600-0.600) | 0.000 (0.000-0.000) | 3 |
| 1,000 | snap | 1000 | none | 1.19 (1.09-1.20) | 1.99 (1.73-2.30) | 2.17 (2.05-2.33) | 464 | 10 | 0.450 (0.373-0.473) | 0.700 (0.700-0.700) | 0.000 (0.000-0.000) | 3 |
| 1,000 | snap | 10000 | none | 5.68 (5.57-6.64) | 12.4 (12.4-13.4) | 13.6 (13.4-14.9) | 3888 | 2 | 1.07 (1.04-1.12) | 0.300 (0.300-0.300) | 0.000 (0.000-0.000) | 3 |
| 1,000 | imm | 100 | none | 0.550 (0.546-0.572) | 0.942 (0.749-1.162) | 1.23 (1.07-1.77) | 48 | 200 | 0.001 (0.000-0.001) | 6.60 (6.60-6.60) | 1.21 (0.98-1.56) | 3 |
| 1,000 | imm | 1000 | none | 1.26 (1.21-1.31) | 1.78 (1.70-2.77) | 3.09 (2.40-3.72) | 464 | 20 | 0.007 (0.006-0.008) | 1.10 (1.10-1.10) | 1.16 (1.14-1.21) | 3 |
| 1,000 | imm | 10000 | none | 4.99 (4.94-5.73) | 14.3 (13.3-14.3) | 15.1 (15.0-16.0) | 3888 | 2 | 0.034 (0.034-0.040) | 0.400 (0.400-0.400) | 1.05 (1.01-1.20) | 3 |
| 1,000 | immfloor | - | none | 0.005 (0.004-0.006) | 0.017 (0.012-0.030) | 0.029 (0.026-0.032) | 0 | 20000 | 0.000 (0.000-0.000) | 30.8 (30.8-30.8) | 1.71 (1.66-1.76) | 3 |
| 1,000 | undo | - | none | 0.036 (0.030-0.037) | 0.157 (0.136-0.197) | 0.422 (0.383-0.450) | 0 | 0 | 0.000 (0.000-0.000) | 0.000 (0.000-0.000) | 0.000 (0.000-0.000) | 3 |
| 1,000 | snap | 100 | group | 2.61 (2.38-2.71) | 3.54 (3.45-4.30) | 5.73 (4.37-6.92) | 48 | 10 | 0.423 (0.382-0.431) | 0.600 (0.600-0.600) | 0.000 (0.000-0.000) | 3 |
| 1,000 | undo | - | group | 0.061 (0.060-0.070) | 0.194 (0.180-0.204) | 0.344 (0.343-0.392) | 0 | 0 | 0.000 (0.000-0.000) | 0.000 (0.000-0.000) | 0.000 (0.000-0.000) | 3 |
| 100,000 | snap | 100 | none | 62.9 (62.1-65.1) | 72.8 (70.6-81.0) | 74.7 (72.3-81.6) | 48 | 10 | 33.5 (32.5-35.2) | 60.2 (60.2-60.2) | 0.000 (0.000-0.000) | 3 |
| 100,000 | snap | 1000 | none | 64.4 (61.3-67.0) | 73.4 (69.6-76.6) | 83.7 (83.6-83.9) | 464 | 10 | 33.6 (31.1-34.3) | 60.8 (60.7-60.8) | 0.000 (0.000-0.000) | 3 |
| 100,000 | snap | 10000 | none | 74.4 (70.5-79.7) | 90.6 (90.5-90.9) | 106.8 (101.8-108.3) | 3888 | 2 | 68.7 (59.4-69.8) | 12.4 (12.4-12.4) | 0.000 (0.000-0.000) | 3 |
| 100,000 | imm | 100 | none | 39.3 (38.2-39.3) | 46.5 (45.6-65.5) | 49.2 (47.4-67.4) | 48 | 200 | 0.002 (0.001-0.002) | 19.4 (19.4-19.4) | 2.71 (2.30-2.80) | 3 |
| 100,000 | imm | 1000 | none | 40.6 (37.9-44.2) | 60.6 (54.2-66.1) | 61.8 (56.7-67.7) | 464 | 20 | 0.008 (0.006-0.008) | 8.10 (8.10-8.10) | 2.16 (2.10-3.18) | 3 |
| 100,000 | imm | 10000 | none | 50.1 (46.7-51.8) | 66.6 (65.8-71.3) | 73.4 (71.9-77.3) | 3888 | 2 | 0.046 (0.045-0.052) | < noise (net -3.0) | 2.66 (2.42-2.96) | 3 |
| 100,000 | immfloor | - | none | 0.008 (0.007-0.008) | 0.014 (0.012-0.027) | 0.040 (0.037-0.041) | 0 | 20000 | 0.000 (0.000-0.000) | 41.1 (41.1-41.1) | 3.35 (2.77-3.38) | 3 |
| 100,000 | undo | - | none | 0.038 (0.037-0.042) | 0.311 (0.245-0.312) | 0.640 (0.547-0.663) | 0 | 0 | 0.000 (0.000-0.000) | 0.000 (0.000-0.000) | 0.000 (0.000-0.000) | 3 |
| 100,000 | snap | 100 | group | 376.5 (333.4-385.0) | 532.4 (460.9-602.2) | 532.4 (460.9-602.2) | 40 | 10 | 34.4 (34.2-34.8) | 60.2 (60.2-60.2) | 0.000 (0.000-0.000) | 3 |
| 100,000 | undo | - | group | 9.93 (9.53-10.36) | 12.4 (11.8-14.1) | 15.8 (12.4-21.5) | 0 | 0 | 0.000 (0.000-0.000) | 0.000 (0.000-0.000) | 0.000 (0.000-0.000) | 3 |
| 1,000,000 | snap | 100 | none | 1,121 (1,057-1,126) | 1,232 (1,129-1,288) | 1,246 (1,138-1,292) | 48 | 10 | 524.4 (500.7-659.3) | 480.2 (480.2-480.2) | 0.000 (0.000-0.000) | 3 |
| 1,000,000 | snap | 1000 | none | 1,047 (1,046-1,069) | 1,157 (1,115-1,203) | 1,160 (1,152-1,304) | 464 | 10 | 508.1 (503.3-552.7) | 481.0 (481.0-481.0) | 0.000 (0.000-0.000) | 3 |
| 1,000,000 | snap | 10000 | none | 1,104 (1,080-1,165) | 1,190 (1,133-1,206) | 1,204 (1,161-1,248) | 3888 | 2 | 950.6 (945.3-987.3) | 96.9 (96.9-96.9) | 0.000 (0.000-0.000) | 3 |
| 1,000,000 | imm | 100 | none | 661.0 (625.3-671.6) | 808.4 (722.5-837.1) | 855.3 (772.8-869.0) | 48 | 200 | 0.003 (0.002-0.003) | < noise (net -11.3) | 5.13 (4.76-5.13) | 3 |
| 1,000,000 | imm | 1000 | none | 677.2 (659.0-681.1) | 739.7 (733.2-761.3) | 771.0 (744.0-797.4) | 464 | 20 | 0.008 (0.008-0.009) | < noise (net -21.5) | 4.71 (4.57-4.96) | 3 |
| 1,000,000 | imm | 10000 | none | 711.7 (673.5-728.7) | 803.2 (745.0-899.8) | 842.7 (788.2-954.6) | 3888 | 2 | 0.044 (0.042-0.052) | < noise (net -37.8) | 4.54 (4.31-5.08) | 3 |
| 1,000,000 | immfloor | - | none | 0.016 (0.014-0.017) | 0.045 (0.045-0.057) | 0.048 (0.046-0.059) | 0 | 20000 | 0.000 (0.000-0.000) | 9.60 (9.60-9.60) | 6.14 (5.67-7.58) | 3 |
| 1,000,000 | undo | - | none | 0.038 (0.030-0.044) | 0.157 (0.152-0.168) | 0.495 (0.481-0.573) | 0 | 0 | 0.000 (0.000-0.000) | 0.000 (0.000-0.000) | 0.000 (0.000-0.000) | 3 |
| 1,000,000 | snap | 100 | group | 6,136 (6,004-6,377) | 8,376 (8,370-8,514) | 8,376 (8,370-8,514) | 40 | 10 | 519.4 (478.4-544.7) | 480.2 (480.2-480.2) | 0.000 (0.000-0.000) | 3 |
| 1,000,000 | undo | - | group | 164.1 (155.0-166.3) | 193.2 (192.1-215.1) | 231.4 (211.9-231.8) | 0 | 0 | 0.000 (0.000-0.000) | 0.000 (0.000-0.000) | 0.000 (0.000-0.000) | 3 |

load average at start of each process: median 1.83, range 0.92-3.20, n=90

### undo checks

| rows | states compared after undo | key order kept | a removed row put back keeps key order |
|---|---|---|---|
| 1,000 | 30 (all equal) | 30 of 30 | ['False'] |
| 100,000 | 30 (all equal) | 30 of 30 | ['False'] |
| 1,000,000 | not checked (a full compare costs O(rows) per rerun) | - | - |

<!-- tables:end -->

"heap kept MB" is the net change in heap across the whole tape walk (after minus before, both after a full collection), so it also holds the data source's own churn. Where the kept Immutable.js maps cost less than that churn, the median is negative and is printed as "< noise": the maps share almost all their memory.

## What the numbers say

**1. At the café's size every way is fast enough.** With 1e3 rows a rerun from the nearest snapshot costs about 0.6 ms (snapshots every 100 inputs) to 1.2 ms (every 1,000), with p90 under 2 ms; snapshots every 10,000 inputs give a 5.7 ms median but a p90 of 12-13 ms, over the bar, because up to 10,000 inputs must be replayed. A whole fork, ready to run with its own `group` view, costs 1.6 ms. With a `group` view on the fork, a snapshot rerun costs about 2.6 ms. So fero test on the café needs no data change: snapshots every ≤ 1,000 inputs, or undo (below), meet 10 ms by 5-300 times.

**2. At 1e6 rows, every way that puts a snapshot back into data costs O(rows): 0.66-1.1 s a rerun, 7-11 times the 100 ms bar.** data's snapshot of 1e6 rows takes about 0.5 s to make and a kept snapshot must be copied before data can adopt it (data writes into an object it adopts), so `snap` reruns cost about 1.1 s whatever the snapshot interval: the replay since the snapshot is cheap (about 1-2 µs an input) and the copy is everything. Keeping the snapshots in a persistent map (Immutable.js) makes *taking* one free (a pointer; 1-5 µs per record, growing with the rows, to keep the map up to date beside data) but not *restoring* one: turning the map back into an object for data costs 0.65-0.82 s (median 0.72 s), so `imm` reruns cost about 0.7 s. The floor, if data's own store shared structure (`immfloor`, no data at all), is 0.02 ms a rerun and 0.1 ms a fork.

**3. Undo needs no snapshot and no data change: 0.03-0.05 ms a rerun at every size.** Running input i, reading what it wrote, and applying its records' inverses puts the state back exactly (the whole state compared equal after every checked undo at 1e3 and 1e5 rows), so a rerun costs about four record folds, whatever the number of rows. It meets 10 ms and 100 ms by more than 200 times. Its limits:
- **Order of reruns.** It serves reruns in tape order, which is how fero test's replay walks a tape (T's replay reruns each changed input on the old version's state just before it). A jump to an earlier input costs the inputs between (about 1-2 µs each to replay, more to undo through).
- **Key order.** A removed row put back by an undo lands at the *end* of data's key order (checked at 1e3 and 1e5 rows: not kept). The values are equal, but a method that iterates rows sees them in another order. To be exact, data needs one small change: put a removed row back at its old place (data's store tombstones a removed row's slot, so the slot exists until compaction). Or fero declares key order outside a resource's state. This is the one data-side item E-06 finds (DATA-04).
- **Views.** Undo applies records, so every view pays its own per-commit cost. With one `group` view a rerun costs 0.06 ms at 1e3 rows, about 10 ms at 1e5 and about 165 ms at 1e6: E-05's finding that data's `group` costs O(rows per bucket) per commit, again. With that fixed in data, undo with views costs what the views' deltas cost.

**4. A fork that runs costs O(rows) in memory.** TEST-06's "a fork costs a record" holds in the store (a fork points at immutable snapshots and segments; DESIGN-V5 §6.2), but to *run* the fork in a process its rows must be in a data source: 1.6 ms at 1e3 rows, about 170 ms at 1e5 and about 2.6 s at 1e6 (snapshot 0.51 s, promote 0.69 s at the first new row, the `group` view 1.8 s), and 250-300 B of heap a row. Two forks alive at once at 1e6 rows hold two copies. A deep copy is 2-3 times worse still (4.6 s at 1e6). For fero test's sizes that is fine; for "fork production and test against it" at millions of rows it is a stated limit, or the reason to give data a shared-structure store later (reasoned).

## What this box cannot show

- The café itself. Its size is taken from T's numbers (reasoned); the café's code did not run here.
- Other resources' shapes. Rows are flat ~100 B objects; methods that read many rows per input would add their own time to every rerun, the same in every method above.
- Storage. TEST-06's "a fork of a 1 GB resource writes < 1 KB" is about the log and snapshot store (forks as pointers to immutable segments, DESIGN-V5 §6.2 piece 8); this experiment measures only the in-memory side, the state a fork needs to run.
- Other CPUs and V8 versions, as in E-05.

## Verdict

**Yes for fero test, with no structural sharing in data, if reruns undo rather than copy.** At the café's size every way passes: a rerun from a snapshot every ≤ 1,000 inputs costs 0.6-1.2 ms and a whole fork 1.6 ms, against 10 ms. At 1e6 rows any rewind that copies a snapshot back into data costs 0.66-1.1 s, 7-11 times the 100 ms bar, and a persistent map does not help as long as data needs a plain object to adopt. Undoing a rerun's own records costs 0.03-0.05 ms at every size, with no snapshot and no data change; it needs reruns in tape order (fero test's replay walks tapes in order) and one small data change to be exact (a removed row put back at its old place in the key order). Views add their own per-commit cost to every rerun (data's `group` at 1e6 rows: about 165 ms, E-05's finding). A fork that runs still costs O(rows) in memory (2.6 s and about 250 B a row at 1e6), which fero test states as its limit; structural sharing in data's store would remove it (0.1 ms a fork with Immutable.js) but is a large change to data's store and every operator, and is not needed for TEST-07.

Q-06: yes, by undo, not by copy: at the café's size (1e3 rows) a rerun from a snapshot costs 0.6-1.2 ms and a whole fork 1.6 ms (bar 10 ms); at 1e6 rows copying a snapshot back into data costs 0.66-1.1 s a rerun (bar 100 ms; Immutable.js snapshots make keeping them free but not restoring them, 0.72 s), while undoing the rerun's records by their inverses costs 0.03-0.05 ms at every size with no data change; exactness needs one small data change (a removed row restored at its old key position), views add their per-commit cost (data's `group`: about 165 ms a rerun at 1e6 rows), and a runnable fork costs O(rows) (2.6 s, about 250 B a row at 1e6). Moves: no candidate up or down (every row runs data the same way); TEST-07 met by design for every candidate that runs data in process (reruns undo in tape order; fero test states that a jump costs the inputs between); TEST-06 met in storage only, with an in-memory fork stated at O(rows); DATA-04 gains one small item (restore a removed row at its key position), and structural sharing in data is not planned now.
