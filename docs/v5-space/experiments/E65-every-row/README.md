# E-65: work over every row, past a fixed row ceiling

**Question.** [MERGE.md](../../MERGE.md) split most whole-resource views across groups (the merger), and kept a fixed one-process ceiling for the four features it could not split: `hold: 'all'`, `f.data.connect()` over the whole resource, code over every row (root code, a handler's `ctx.data`), and a live median or quantile. About 1e6 to 5e6 rows, at most 16,777,216 rows a `data` source, about 0.28 M writes a second. The next question was whether any fixed ceiling is needed, given that the asking process can read each group's rows from the servers that hold them; this experiment builds each way round it that it found. No server holds the whole resource in that design. The limit sits on the **asker**, the process that wants every row: its memory, how fast it folds writes, and data's cap of rows a source.

Five options were built small, each with a seeded oracle and planted bugs, and timed. A skeptic then checked the comparison against the code and the records; its findings were checked, and four probes were added (in `probes/`). The design page is [EVERYROW.md](../../EVERYROW.md).

## The answer first

- **No feature needs a fixed row count.** Five of the seven ways to work over every row need no row ceiling at all. The other two, a sync read of every row (`hold: 'all'` and a whole `connect()`), are bounded by the asker's own `memory`, which the operator sets *(checked: X1 to X4)*.
- **One-time work over every row is a scan** (X2): every row once, in pages, from one copy of each group, at one cut. 1e7 rows over 16 groups at 0.75 to 0.83 M rows a second with the asker's heap at 33 to 59 MB *(measured)*; 0 failed in 14,100 seeds over three modes, one cut held in 4,700 *(checked)*.
- **Live code over every row is a fold per group** (X3): the server's author writes `emit` with one of fero's combines; a merger adds the pieces. 0 wrong in 1,375,885 checks over 3,502 seeds *(checked)*. fero's own runtime checks did not see the merger's planted bugs (0 of 30 seeds each); only the test oracle did *(checked)*.
- **A median needs no rows.** An exact live median keeps one sorted column of the one field: 12.8 B a value at 1e7 values, a change in 1,508 to 1,653 ns *(measured, probe)*. X4's histograms give a median within 1 % with no values held, and an exact one with a band of 0.2 to 0.8 % of the values (about 5 % for whole numbers) *(checked, counted)*.
- **A sync read of every row is limited by more than memory.** At 1e6 rows fero's frame decode and the fold run 0.27 to 0.30 M writes a second with no live view, but data's own live views set the real rate: a top 10 (`za`) costs 2.5 to 2.6 ms a write and a median 0.15 to 0.19 ms *(measured)*, because both move a flat array on every change. Rows in one store per group cut the top 10 to 23 to 25 µs a write at 64 stores *(measured, probe)*. A full collection at 5e6 rows pauses the main thread 0.9 to 1.3 s *(measured)*, past F-06's 1 s bar for a process that leads groups.
- **Rows read sync need not sit in `data`.** X1's column store reads a row sync in 2.5 to 3.4 µs, takes 296 to 300 B of RSS a row (against 698 to 703 B for data), pauses 9.5 to 14.3 ms at 5e6 rows, and folds 0.15 to 0.20 M writes a second with its own live views *(measured)*. It loses data's operators.

## The parts

| Part | What it is | Built and checked in | Its README |
|---|---|---|---|
| [X1/](X1) | the asker's `memory` as the limit; stores by block or by group; a column store, an arena, keys on disk, SQLite; worker threads; a sorted column for an exact live median | one process; the guard at a 32 MB budget | [X1/README.md](X1/README.md) |
| [X2/](X2) | `scan()`: every row once, in pages, from one copy of each group, at one cut by default | seeded sim; timed over TCP at 1e7 rows | [X2/README.md](X2/README.md) |
| [X3/](X3) | folds per group: `emit` and a combine, a partial per group, a merger on one server | one process, no network | [X3/README.md](X3/README.md) |
| [X4/](X4) | a histogram per group (relative error a), summed at the asker; a band of exact values near the rank | one process, scaled down (64 slots, 2 to 8 groups) | [X4/README.md](X4/README.md) |
| [X5/](X5) | a slot sample with intervals; clients that merge; a sized holder and other ways, reasoned | one process, no groups | [X5/README.md](X5/README.md) |
| [probes/](probes) | after the skeptic: each live view's cost on a big hold (`views-fold`), a forced collection's pause (`forced-gc`), a seeded oracle for the sorted column (`sortedcol-oracle`), the fold with many groups' small frames and a store per group (`asker-fold`), the sorted column at 1e7 values (`sortedcol-scale`) | one process | this page |

## Results

Marks: *(measured)* three runs, each process alone under the timing lock, a range; *(checked)* a seeded run with an oracle and planted bugs, or a probe; *(counted)* from a run's output; *(reasoned)* nothing ran it. Timed cells ran on Node 22.22.0, 4 CPUs, `data` at 63fea66.

| What | Result | Mark, source |
|---|---|---|
| The budget guard (`confirm` policy), one hold, 32 MB budget | 0 of 100 seeds failed; warned at 80 to 84 %, refused at 90 to 96 % of live heap; the other five policies failed 32 to 100 of 100 | checked, X1 `budget` (heavy lock, load 2 to 10) |
| Bytes a row at 1e6 rows, after 1e6 more writes | data: 296 B heap, 698 to 703 B RSS; column: 296 to 300 B RSS; keys on disk: 191 B RSS + 254 B on disk; SQLite: 160 to 164 B RSS + 163 B on disk | measured, X1 `mem` |
| A forced full collection, rows in one data source | 1e6 rows: 203 to 260 ms; 5e6 rows (1.5 GB heap): 943 to 1,335 ms | measured, probe `forced-gc` (three runs: two by the skeptic, one after) |
| The fold at 1e6 rows, no live view, frames of 256 | with fero's frame decode 0.27 to 0.30 M records a second; the fold alone 0.50 to 0.54 M | measured, X1 `workers` W = 0 and `fold` |
| The same, frames of 4 records, one store / 64 stores | 0.49 to 0.50 M / 0.43 M records a second | measured, probe `asker-fold` |
| data's views alone on a 1e6-row hold, a write | none 2.1 to 2.3 µs; `sum` 2.7 to 2.9 µs; `length` 2.1 µs; `za('score', 10)` 2.5 to 2.6 ms; `median` 0.15 to 0.23 ms; all four 3.3 to 4.3 ms | measured: X1 `timing` (all four, median); probe `asker-fold` (`za`); probe `views-fold` (none, `sum`, `length`: two runs) |
| `za` per store, 64 / 256 stores, frames of 4 | 23 to 25 µs / 15 to 16 µs a write | measured, probe `asker-fold` |
| A sync `get` | data 0.83 to 1.05 µs; column 2.5 to 3.4 µs; keys on disk 2.3 to 2.8 µs; SQLite 6.9 to 8.1 µs; a worker thread 45 to 52 µs (a trip) | measured, X1 |
| GC pauses loading 5e6 rows | data 1,252 to 1,341 ms; column 9.5 to 14.3 ms; arena 5.4 to 6.1 ms | measured, X1 `gc` |
| Sources by block past 2^24 rows | exact in 1,000 seeds (0 failed); planted `route` failed 1,000 of 1,000 | checked, X1 `sims` (the 2e7-row run was not run) |
| `scan()` at one cut | 0 failed in 14,100 seeds (4,700 at one cut), 0 of 1,119,674 multi-slot commits torn; 1e7 rows at 0.75 to 0.83 M rows a second, one number field 16 to 20 M a second, asker heap 33 to 59 MB | checked, measured, X2 |
| X2's planted bugs | most fail 766 to 1,000 of 1,000 seeds in the hard world; `oldpair` only 63 (0 in the default world, 16 of 2,000 in stress) | checked, X2 |
| Folds with fero's combines | 0 wrong in 1,375,885 checks, 3,502 seeds; a write at a group copy 0.73 to 4.47 µs (with remove), 5.7 to 19.6 µs (max, top k with a `keeps` hint); merger 18,000 to 26,000 writes a second for max or top k at 256 groups, one write a frame | checked, measured, X3 |
| fero's own checks on X3's builder bugs | `nopair`, `resyncadd`, `mixver`: flagged in 0 of 30 seeds each; the oracle failed 13, 26 and 30 of 30 | checked, X3 quick |
| Histograms (X4) | within a in 10,299,972 checks, 0 failures; exact band at a = 0.1 %: 0.2 to 0.8 % of values for smooth data, 4.95 % for whole numbers at any a; band change 0.55 to 0.81 µs | checked, counted, measured, X4 |
| The sorted column (X1-Q) | 0 failed of 300 seeds, 7,198,913 checks; planted `nextchunk` 300 of 300, `nointerp` 292 of 300 | checked, probe `sortedcol-oracle` |
| The sorted column at 1e6 / 1e7 values | a change 872 to 1,107 / 1,508 to 1,653 ns; a median read 2.0 to 2.2 / 13.7 to 15.3 µs; 12.2 / 12.8 B a value | measured, probe `sortedcol-scale` |
| A slot sample (X5) | 95 % intervals held the truth 92.5 to 94.8 % (moderate data), 85.8 to 93.6 % (heavy tails) | checked, X5 |
| Clients that merge a top 10 (X5) | 14 to 20 times the frames at 16 groups, 217 to 318 at 256 | counted, X5 |
| data frees a dropped source? | no: 18 to 23 MB kept per 1e5 rows after `drop` or `dispose`; `clear` frees | checked, X1 `probe-drop` |

## After the skeptic

The skeptic's 23 findings were checked against the code and the records. All held except the image size in its finding 8 (X2's pin model gives up to about 70 MB a copy for a 625,000-row group, not 79 MB). What changed here: the skeptic's probes `views-fold`, `forced-gc` and `sortedcol-oracle` are kept; `forced-gc` was run a third time, and `views-fold`'s `za` cell was timed again three times through the new `asker-fold`; `sortedcol-scale` is new. The part READMEs were corrected where the skeptic found a claim too wide (X1's sorted column cost and size, X2's seed count, X4's comparison). The skeptic's single timed runs are in `probes/results/skeptic-timing.jsonl`; the three runs are in `probes/results/timing.jsonl`.

## Verdict

A fixed row ceiling is not the best answer for any feature. One-time work becomes a scan, live code a fold per group, a median a sorted column or a histogram: none holds rows. A sync read of every row keeps a limit, but it is the asker's `memory` counted the way the box counts it (RSS), and the speed of data's live views on the hold, which a chunked index in `data` 5 can fix. Stores by group inside the asker are a measured fallback for the views. A compact store is the later answer for big holds with a fixed row shape.

## Limits

- X3, X4 and X5 ran in one process with no network; X4's world was scaled down. X2's replicated pin ran only in the seeded world. The lease, `scan-lost` and the image budget were not built.
- The sorted column at the merger (a part per group, replaced on a resync, values moved on a slot move) was not built; only the column itself is checked.
- The guard was checked for one hold in an empty process, at 32 MB, one fill to the first refusal. A guard that counts RSS, two holds sharing a budget, and a long steady state near the line were not run.
- The fold rates time records already decoded; a network frame's decode is not in them.
- The probes' runs list the box's load; see each line's `loadavg`.

## How to run

```sh
./run.sh quick     # every part small and the probes small, no results written; ends "E-65 quick: ok"
./run.sh full      # every part in full (hours), then the probes
./run.sh probes    # the probes in full: the oracle, then three timed runs
./run.sh x2 sim    # one part, one step (each part's run.sh lists its steps)
./run.sh summary   # each part's results in short
```

`SP` names a scratch folder of your own holding `bin/timing` (runs a command alone on the box) and `bin/heavy` (shares the box but waits for timing runs); without it the locks are skipped. `DATA` is data's folder, by default `../data` next to this repo, at 63fea66, read only. Every process stays under 4 GB (`--max-old-space-size=3000` to `3500`).
