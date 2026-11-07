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
- **Timing.** One `$SP/bin/timing` hold per run, 3 runs, every process well under 60 s and preceded by its load average. Run 1 used the default 2 GB heap and stopped at 1e6 rows (`fork.mjs` ran out of memory holding the parent, a fork, a deep copy and an Immutable map at once); runs 2 and 3 and run 1's 1e6 part ran with `--max-old-space-size=6144`. Tables give the median of the runs and, in brackets, the spread (lowest and highest run). Machine: 4 vCPU, 16 GB, Linux 6.18 (Firecracker VM), Node 22.22.0 (V8 12.4).

To reproduce: `./fetch.sh`, `./run.sh`, then `python3 summarize.py`.

## Results

Raw lines: [results/fork.jsonl](results/fork.jsonl) and [results/rewind.jsonl](results/rewind.jsonl).

<!-- tables:start (python3 summarize.py) -->
<!-- tables:end -->

## What the numbers say

**1. At the café's size every way is fast enough.** With 1e3 rows a rerun from the nearest snapshot costs about 0.6 ms (snapshots every 100 inputs) to 1.2 ms (every 1,000), with p90 under 2 ms; snapshots every 10,000 inputs give a 5.7 ms median but a p90 of 12-13 ms, over the bar, because up to 10,000 inputs must be replayed. A whole fork, ready to run with its own `group` view, costs 1.6 ms. With a `group` view on the fork, a snapshot rerun costs about 2.7 ms. So fero test on the café needs no data change: snapshots every ≤ 1,000 inputs, or undo (below), meet 10 ms by 5-300 times.

**2. At 1e6 rows, every way that puts a snapshot back into data costs O(rows): 0.65-1.2 s a rerun, 7-12 times the 100 ms bar.** data's snapshot of 1e6 rows takes about 0.57 s to make and a kept snapshot must be copied before data can adopt it (data writes into an object it adopts), so `snap` reruns cost about 1.1 s whatever the snapshot interval: the replay since the snapshot is cheap (about 1-2 µs an input) and the copy is everything. Keeping the snapshots in a persistent map (Immutable.js) makes *taking* one free (a pointer; 1-5 µs per record, growing with the rows, to keep the map up to date beside data) but not *restoring* one: turning the map back into an object for data costs 0.65 s, so `imm` reruns cost about 0.7 s. The floor, if data's own store shared structure (`immfloor`, no data at all), is 0.02 ms a rerun and 0.1 ms a fork.

**3. Undo needs no snapshot and no data change: 0.03-0.05 ms a rerun at every size.** Running input i, reading what it wrote, and applying its records' inverses puts the state back exactly (the whole state compared equal after every checked undo at 1e3 and 1e5 rows), so a rerun costs about four record folds, whatever the number of rows. It meets 10 ms and 100 ms by more than 200 times. Its limits:
- **Order of reruns.** It serves reruns in tape order, which is how fero test's replay walks a tape (T's replay reruns each changed input on the old version's state just before it). A jump to an earlier input costs the inputs between (about 1-2 µs each to replay, more to undo through).
- **Key order.** A removed row put back by an undo lands at the *end* of data's key order (checked: not kept, at every size). The values are equal, but a method that iterates rows sees them in another order. To be exact, data needs one small change: put a removed row back at its old place (data's store tombstones a removed row's slot, so the slot exists until compaction). Or fero declares key order outside a resource's state. This is the one data-side item E-06 finds (DATA-04).
- **Views.** Undo applies records, so every view pays its own per-commit cost. With one `group` view a rerun costs 0.06 ms at 1e3 rows, 9.5 ms at 1e5 and about 170 ms at 1e6: E-05's finding that data's `group` costs O(rows per bucket) per commit, again. With that fixed in data, undo with views costs what the views' deltas cost.

**4. A fork that runs costs O(rows) in memory.** TEST-06's "a fork costs a record" holds in the store (a fork points at immutable snapshots and segments; DESIGN-V5 §6.2), but to *run* the fork in a process its rows must be in a data source: 1.6 ms at 1e3 rows, about 160 ms at 1e5 and about 2.6 s at 1e6 (snapshot 0.57 s, promote 0.72 s at the first new row, the `group` view 1.9 s), and about 250 B of heap a row. Two forks alive at once at 1e6 rows hold two copies. A deep copy is 2-3 times worse still (4.6 s at 1e6). For fero test's sizes that is fine; for "fork production and test against it" at millions of rows it is a stated limit, or the reason to give data a shared-structure store later (reasoned).

## What this box cannot show

- The café itself. Its size is taken from T's numbers (reasoned); the café's code did not run here.
- Other resources' shapes. Rows are flat ~100 B objects; methods that read many rows per input would add their own time to every rerun, the same in every method above.
- Storage. TEST-06's "a fork of a 1 GB resource writes < 1 KB" is about the log and snapshot store (forks as pointers to immutable segments, DESIGN-V5 §6.2 piece 8); this experiment measures only the in-memory side, the state a fork needs to run.
- Other CPUs and V8 versions, as in E-05.

## Verdict

VERDICT_TEXT

VERDICT_LINE
