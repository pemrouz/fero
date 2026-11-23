# Every row, past a fixed ceiling: what each feature needs

2026-11-23. [MERGE.md](MERGE.md) split most work over every row across groups (the merger), and kept a fixed one-process ceiling for the four features it could not split: `hold: 'all'`, `f.data.connect()` over the whole resource, code over every row (root code, a handler's `ctx.data`), and a live median or quantile (its 5.4 item 1 and question 2). The next question was whether any fixed ceiling is needed, given that the asking process can read each group's rows from the servers that hold them; this page studies every way round it. In that design no server holds the whole resource. The limit sits on the **asker**, the process that wants every row: its memory, how fast it folds writes, and `data`'s cap of 16,777,216 rows a source (which `data` 5 lifts with a key index in small tables, V5-21 item 2). The owner took this page's picks on 2026-11-23 as [V5-20](../DECISIONS.md) items 3 to 8, one at a time, and V5-20's Consequences put this page's limits in place of MERGE's ceiling. Question 9 went another way: V5-20 item 9 asked for a study of compact rows first ([COMPACT.md](COMPACT.md)), and [V5-21](../DECISIONS.md) then superseded it. The page now gives the picks as decided, keeps its first answer to question 9 as history, and says what is still owed (sections 8 and 9).

**How it was made.** Five options were built small in [E-65](experiments/E65-every-row/README.md), each with a seeded oracle and planted bugs, and timed: X1 the asker's own `memory` (with stores by block or group, compact stores, workers, a sorted column), X2 a scan, X3 folds per group, X4 histograms per group, X5 a sample and the other ways. A comparison picked one per feature. A skeptic checked it against the code and the records. Its findings held, except one number (section 3.4), and are taken in here. The biggest: the speed limit of a whole-resource hold is not the fold (0.28 M writes a second) but `data`'s own live views on it, which move a flat array on every write. Four probes were added to E-65 to measure that and the other gaps.

**Marks.** *(measured)*: timed, three runs, each process alone on the box, a range. *(checked)*: a seeded run with an oracle and planted bugs, or a probe, whose output is in E-65. *(counted)*: a count from a run. *(reasoned)*: an argument; nothing ran it. *(a guess)*: nobody measured it. *(from memory)*: an outside fact not checked here. X1 to X5 and "probe" are E-65's parts; O1 is E-64's merger; G5 and the like are items of [GROUPS.md](GROUPS.md); V5-n are entries of [DECISIONS](../DECISIONS.md). Rules are counted as [LAYERS.md](LAYERS.md) 9.4 and [SIMPLICITY.md](SIMPLICITY.md) count them: a **builder rule** is one a builder must get right; a **user rule** is one an app author must know.

---

## 0. The answer

1. **No feature needs a fixed row count.** Five of the seven ways to work over every row need no row ceiling at all *(checked: X2, X3, X4, O1)*.
2. **One-time work over every row is a scan**: every row once, in pages, from one copy of each group, at one cut. Its limit is time: 0.75 to 0.83 M rows a second at one asker *(measured, X2)*. Decided: `scan()`, a new read verb, in the first build, at one cut by default (V5-20 item 4).
3. **Live code over every row is a fold per group**: the server's author writes `emit` with one of fero's combines, and the merger adds the pieces *(checked, X3)*. Decided, in the first build (V5-20 item 5).
4. **A live median keeps one number a row of one field, no rows**: a sorted column at the merger, exact, 12.8 B a value at 1e7 values *(measured, probe)*. Later, histograms (X4) need no values at all. Decided: exact first (V5-20 item 6).
5. **A one-time median is O1's read** at the scan's cut: it holds nothing *(measured, O1; reasoned, X2)*.
6. **A sync read of every row** (`hold: 'all'`, a whole `connect()`) needs every row in this process. Its limit becomes the process's own `memory`, counted the way the box counts it (RSS): about 1.4 M small rows a GB *(measured, X1)*. Health warns at 80 %; past the line the hold ends `not-held`. Decided as picked (V5-20 item 3), with this page's other two parts: a hold that will not fit is refused at open, and near the line, whole-resource holds end first, then a server refuses writes `read-only`.
7. **What really slows a big hold is `data`'s live views on it**, not the fold. At 1e6 rows a top 10 costs 2.5 to 2.6 ms a write and a median 0.15 to 0.19 ms *(measured)*. A chunked index in `data` 5 should fix both *(reasoned)*; one store per group inside the asker is the measured fallback. Decided: `data` 5 fixes them (V5-20 item 7).
8. **A big hold pauses its process**: 0.9 to 1.3 s for one full collection at 5e6 rows *(measured, probe)*, past F-06's 1 s bar for a process that leads groups. Decided: allowed under `memory`, with a health warning once a full collection there passes 0.5 s (V5-20 item 8).
9. **Rows read sync need not live in `data`**: a compact column store reads a row sync in 2.5 to 3.4 µs, at 0.4 times data's RSS and 1 % of its pauses, but loses data's operators *(measured, X1)*. This page said: later, for big holds with a fixed row shape. Superseded by V5-21: no compact store in the first build (item 1); when one comes, it sits inside `data` as a second backing, so every operator still runs (item 3), and a resource turns to it only by an explicit setting its author chooses (item 7). A store of fero's own for big holds is rejected.
10. **Cost of the first build:** about +20 to +37 builder rules and +2 to +5 user rules over MERGE's pick, and 4 `data` 5 items *(reasoned)*.
11. **Ten questions** for the owner end the page (section 9). V5-20 answered them; question 9 is superseded by V5-21.

---

## 1. Words

- **Asker.** The process that wants every row. **Group**: one Raft log; it owns some of the resource's 4,096 slots. **Copy**: one server's replica of one group.
- **Hold.** Rows kept in this process on purpose, live, so a sync read can see them. **Sync read**: `.value` or `get()` that answers now, with no wait (V5-16).
- **To fold.** To apply a committed write to the rows in memory. **Live view**: an operator, such as `za('score', 10)` (the 10 highest scores), kept up to date on every fold.
- **Budget.** This process's `memory` setting (API.md 9). **RSS**: the memory the box sees the process use, garbage and all. **Live heap**: what the JavaScript heap holds after a full collection.
- **Cut.** One position per group. A read at one cut never shows part of a commit.
- **Merger.** One server that adds up small per-group pieces of a view by key (MERGE.md). **Partial**: one group's piece.
- **Scan.** Every row once, in pages, from one copy of each group. **Fold** (X3): code the server's author writes as `emit` (what one row adds) and a combine (how two pieces add up).
- **Sorted column.** One field's values kept in sorted chunks of 512 to 1,024 numbers: a change and a rank cost little.
- **Histogram** (X4). Counts of values in buckets whose width grows with the value, so any rank is known within a relative error a. **Band**: the exact values near the wanted rank.

---

## 2. What each feature needs

| Feature | Needs every row together? | Needs a sync answer? | Live? | So the smallest thing that does it |
|---|---|---|---|---|
| `hold: 'all'`, a whole `connect()` | yes | yes (`.value`, `get()`) | yes | every row in this process: memory |
| one-time code over every row, on a client | no: each row once | no (`for await`) | no | a scan |
| one-time root code or `ctx.data` over every row, on a server | no | no | no | a scan; own groups read in place |
| live code over every row (a view that does not merge) | no, if it is a fold | no | yes | a fold per group and a merger |
| live code that is not a fold (pairs of rows, arrival order) | yes | — | yes | every row in one process (a hold) |
| a live median or quantile | no: one field's values, or counts | no | yes | a sorted column, or histograms |
| a one-time exact median | no | no | no | O1's selection, at one cut |

Only the first and the fifth rows need every row in one process *(reasoned)*.

---

## 3. The options, built and timed

### 3.1 F, MERGE's fixed ceiling (the baseline)

- **What.** The asker holds every row in one `data` source and folds every write (R0). About 1e6 to 5e6 rows, 2^24 a source, about 0.28 M writes a second *(G5, G6: checked and reasoned)*.
- **Rules.** +1 builder, +1 user (G5).
- **Against it.** A row count is a guess at the operator's memory; the same count is too small on a 64 GB box and too big on a 1 GB one *(reasoned)*. V5-20 rejects a fixed row ceiling (item 3).

### 3.2 X1-M, the budget: the asker's own `memory`, with variations

- **What.** Hold every row as F does; the limit is this process's `memory`. A guard measures what the hold costs, warns at 80 %, refuses a new hold that will not fit, and ends a live one `not-held` past the line, removing its rows.
- **Results.** The guard that confirms with a full collection failed 0 of 100 seeds (warned at 80 to 84 %, refused at 90 to 96 % of live heap); the four cheaper ways to measure failed 32 to 100 of 100 *(checked, X1, one hold at 32 MB)*. data's rows cost 296 B of heap and **698 to 703 B of RSS** a small row after writes: RSS is 2.3 to 2.6 times live heap *(measured, X1 `mem`)*. So a GB holds about 3.4 M rows by live heap but about 1.4 M by RSS, and the box kills on RSS.
- **The fold and the views.** With no live view, fero's frame decode and the fold together run 0.27 to 0.30 M writes a second at 1e6 rows, in frames of 256 *(measured, X1)*. The fold alone runs 0.50 to 0.54 M *(measured, X1)*, and 0.49 to 0.50 M in frames of 4 records *(measured, probe)*: small frames cost the fold little. Their decode was not timed. `data`'s views change that by a thousand times: `za('score', 10)` costs 2.5 to 2.6 ms a write, `median` 150 to 193 µs, all four of X1's views 3.3 to 4.3 ms (234 to 303 writes a second) *(measured, X1 and probe)*. Both move a flat array on every write *(reasoned from data's code)*, so the cost grows with the rows (at 1e5 rows `za` was 115 µs a write: ten times the rows, 25 times the cost *(one run, probe)*). `sum` and `length` add under 1 µs *(two runs, probe)*.
- **Pauses.** One forced full collection takes 203 to 260 ms at 1e6 rows and 943 to 1,335 ms at 5e6 rows (1.5 GB of heap) *(measured, probe)*; V8's own collections while loading 5e6 rows were 1,252 to 1,341 ms *(measured, X1)*. F-06 allows no pause over 1 s on a process that leads groups ([REQUIREMENTS](REQUIREMENTS.md) F-06).
- **The guard as built.** It forces a full collection at each tenth from 50 % and before each line: 4 to 6 a fill *(reasoned from its rule)*. It needs `gc()`, which a library gets without a node flag through `v8.setFlagsFromString('--expose-gc')` and `vm.runInNewContext('gc')` *(checked, Node 22.22)*. It was proved for one hold in an empty process, in one fill to the first refusal.
- **Variation: count RSS.** Read RSS (2 µs a call *(measured, X1)*) against the line. RSS is never below what the box sees, so no forced collection is needed to stay safe; one before ending a hold avoids ending it for garbage, and it is skipped on a process that leads groups *(reasoned, not built)*.
- **Variation: stores by block or by group.** The asker keeps S sources by slot. Past 2^24 rows: exact in 1,000 seeds, planted `route` failed 1,000 of 1,000 *(checked, X1; the 2e7-row run was not run)*. A view per store is cheaper, since each holds 1/S of the rows: `za` per store costs 23 to 25 µs a write at 64 stores and 15 to 16 µs at 256 *(measured, probe)*; X1's 16 blocks with all four views ran 21,200 to 22,100 writes a second *(measured)*. The frames of 64 groups, 4 records each, fold at 0.43 M writes a second, against 0.49 to 0.52 M for one store in frames of 256 *(measured, probe)*. But only operators that merge (sum, count, top k, min, max, filter) can run per store; data's other operators over every row cannot *(reasoned)*. +2 to +4 builder rules *(reasoned, X1)*.
- **Variation: a compact store.** Rows in typed arrays off the heap (X1's column form): 296 to 300 B of RSS a row, a sync `get` in 2.5 to 3.4 µs, pauses of 9.5 to 14.3 ms loading 5e6 rows, a fold with its own views (count, sum, top, a sorted-column median) of 0.15 to 0.20 M writes a second *(measured, X1)*. Keys on disk: 191 B RSS + 254 B on disk, `get` 2.3 to 2.8 µs *(measured)*. These reads are sync. What they lose is data's operators: fero writes its own views (+9 to +15 builder rules) *(reasoned, X1)*.
- **Variation: worker threads.** Rows split over 3 workers fold 0.63 to 0.75 M writes a second with views kept on the main thread *(measured, X1)*; a `get` is a trip, 45 to 52 µs, so not for `.value`. +3 to +5 builder, +1 user.
- **Also found.** `data` keeps 18 to 23 MB per 1e5 rows after `drop` or `dispose` of a source *(checked, X1 probe)*: a leak to fix in `data` 5.

### 3.3 X1-Q, a sorted column for an exact live median

- **What.** One sorted column of the one field, fed each changed row's value before and after; no rows. At the merger it keeps one part per group, so a resync can replace a group's part and a slot move can move values between parts.
- **Results.** The column passed a seeded oracle: 0 failed of 300 seeds, 7,198,913 checks; planted bugs failed 300 and 292 of 300 *(checked, probe)*. It adds +0.5 to +1.7 µs a write over the fold at 1e6 rows *(measured, X1)*. Alone, at 1e6 and 1e7 values: a change 872 to 1,107 and 1,508 to 1,653 ns, one median read 2.0 to 2.2 and 13.7 to 15.3 µs, 12.2 and 12.8 B a value after a million changes *(measured, probe)*. A read walks the chunks one by one, so it grows with the values; an index over the chunk sizes makes it a few steps *(reasoned)*.
- **Not built.** The column at the merger, fed by many groups, with parts, resyncs and moves. A remove that finds no value returns `false` today; it must be loud, or a lost value drifts in silence *(reasoned)*.
- **Rules.** +3 to +5 builder (the column, a part per group, the resync, the move, the loud remove), 0 user *(reasoned)*.

### 3.4 X2, a scan

- **What.** A read verb beside `get()` and `connect()`: `for await (const [key, row] of f.data.scan())`. Pages from one copy of each group; at one cut by default (`cut: false` opts out); `fields`, `columns`, `pages`, `ahead`, `signal`; a plain-data filter left of it runs at the copies. On a server, groups held there are read in place, the rest by pages, with no download.
- **Results.** 0 failed in 14,100 seeds over three modes (4,700 at one cut), 0 of 1,119,674 multi-slot commits torn *(checked, X2)*. 1e7 rows over 16 groups over TCP: 0.75 to 0.83 M whole rows a second, 16 to 20 M a second for one number field, the asker's heap 33 to 59 MB; own groups in place at 101 to 113 ns a row *(measured, X2)*. Most planted bugs failed 766 to 1,000 of 1,000 seeds in the hard world; `oldpair` failed only 63 (0 in the default world), a rare but real case *(checked)*.
- **The cost to servers.** One cut keeps a before-image of a pinned row the first time it changes, on every copy, until the scan ends: up to about 70 MB a copy for a 625,000-row group *(counted, X2's pin model; the skeptic said 79 MB, the model gives 69.7)*. Those bytes count against the server's `memory`, whose line refuses writes. So an image budget is owed: past it the scan ends `scan-lost`, never the writes (X2's C6, not built; owed, V5-20).
- **Rules.** One cut +9 to +19 builder (about 11), no cut alone +4 to +9; user +1 to +3 *(reasoned, X2)*.

### 3.5 X3, folds per group

- **What.** The server's author declares `fold: { emit }` with one of fero's own combines: `sum`, `count`, `min`, `max`, `top(k)`, `distinct` (O1's merge classes, with exact sums). A partial per group on a copy that is not the leader (as X3 built it; where a partial lives is now V5-20 item 13's rule: any copy of its group, preferring one that leads no group of its resource, [MERGE.md](MERGE.md) 5.2); a merger on one server; clients read it as a served view.
- **Results.** 0 wrong in 1,375,885 checks over 3,502 seeds, through moves, resyncs, outages and deploys *(checked, X3)*. A write at a group copy costs 0.73 to 4.47 µs (classes with remove), 5.7 to 19.6 µs (max, top k with a `keeps` hint); the merger takes 18,000 to 26,000 writes a second for max or top k at 256 groups, one write a frame, because it combines every group's piece of a touched bucket *(measured, X3)*. A tree over the groups would combine 8 pieces, not 256 *(reasoned, X3)*.
- **What fero can and cannot see.** The self-check at build named the broken law in 300 of 300 seeds for each of 9 author mistakes *(checked)*. But fero's runtime checks flagged the merger's own planted bugs (`nopair`, `resyncadd`, `mixver`) in 0 of 30 seeds each; only the test oracle saw them *(checked, X3)*. So a merger audit is owed: now and then, rebuild the answer from fresh pieces of every group at one cut and compare *(reasoned)*. V5-20 item 5 takes it, and it is owed. The self-check runs on pieces of real rows; on an empty resource it must run again once rows exist *(reasoned)*.
- **Rules.** +3 to +5 builder, +1 for the audit; user 0 to +1 *(reasoned, X3)*. User combines later: +8 to +13 builder in all, +3 to +5 user.

### 3.6 X4, histograms per group

- **What.** Each group keeps bucket counts with a relative error a; the asker sums them. For an exact answer it also keeps the band of exact values near the rank.
- **Results.** Within a in 10,299,972 checks with groups, moves and resyncs, 0 failures; planted bugs failed 822 to 1,000 of 1,000 seeds *(checked, X4)*. The band at a = 0.1 % holds 0.2 to 0.8 % of the values for smooth data, but 4.95 % for whole numbers at any a *(counted, X4)*: a smaller budget, not none. Kept as (value, count) pairs, whole numbers would need a handful of pairs *(reasoned, not built)*. A band change costs 0.55 to 0.81 µs at a = 0.1 %, up to 4.9 µs at 4e5 band values *(measured)*. Buckets grow with the log of the value range: 138,057 for a very wide mix at a = 1 % *(counted)*. A one-time median takes 1 to 3 trips, 36 to 49 ms at 1e6 rows *(measured, one process)*.
- **Limits.** Scaled down: 64 slots, 2 to 8 groups, about 1,500 live rows, no network. The approximate form changes `data`'s exact promise.
- **Rules.** Approximate 4 to 6 builder (2 to 4 new), +1 user; the exact band +2 to +3 *(reasoned, X4)*.

### 3.7 X5, a sample and the other ways

- **A slot sample.** The asker holds k of 4,096 slots and scales up, with an interval. At k = 256, ±4 to ±12 % *(checked)*; the 95 % intervals held the truth 92.5 to 94.8 % for moderate data and 85.8 to 93.6 % for heavy tails *(checked, X5)*, short of 95 % because rows of one slot come and go together. A sample by row hash, kept by a filter at the copies, should sit nearer *(reasoned, not built)*. Never min, max, top k or distinct. +4 to +7 builder, +1 to +2 user.
- **A sized holder.** One chosen server holds every row for many askers; an asker reads by a trip (40 µs p50 on loopback, PATHS). +2 to +4 builder, +1 user *(reasoned)*.
- **Clients that merge** a top 10 take 14 to 20 times the frames at 16 groups, 217 to 318 at 256 *(counted, X5)*: they lose to a merger.
- **Rows fetched when touched, a hybrid hold, the asker as a cluster**: each turns a sync read of a missing row into a network trip *(reasoned, X5)*. A local sync store (3.2's compact store) is not a trip.

### 3.8 Ideas not built

- **Track the pivot for an exact median with no values at the merger.** Each group keeps a sorted column of its own rows; the merger keeps the median and the counts below and above it, and asks the groups for the next few values when a frame moves the rank: one trip a frame *(reasoned)*.
- **A tree over groups** at the merger for max and top k (from X3).
- **A compact hold** offering sync reads and the merge classes only (3.2's column form with fero's views). Superseded: V5-21 rejects a store of fero's own for big holds; a later compact store is a second backing inside `data` (V5-21 item 3).

---

## 4. The comparison

Cells: **covers**, **partly** or **no**, with the number that decides it. "—": the option does not touch it.

| Feature | F fixed ceiling | X1-M budget | X1-Q sorted column | X2 scan | X3 fold | X4 histogram | X5 sample / holder |
|---|---|---|---|---|---|---|---|
| `hold: 'all'`, a whole `connect()` | partly: 1e6 to 5e6 rows | **covers to `memory`**: 1.4 M small rows a GB of RSS; live views and pauses set the speed (3.2) | no | partly: a `connect()` opened and ended in one call | no | no | holder: a trip a read |
| one-time code over every row (client or server) | partly | partly: rows held | — | **covers, no ceiling**: 0.75 to 0.83 M rows a second | partly: only a fold | — | sample: an estimate |
| live code over every row | partly | partly, under `memory` | — | no | **covers code that is a fold** | quantiles only | sample: estimates; holder: any code |
| live code that is not a fold | partly | **covers to `memory`** | — | no | no | no | holder |
| a live median or quantile | partly: 150 to 193 µs a write at 1e6 | partly | **covers, exact**: 12.8 B a value on one server | no | no | **covers, no values**: within a; exact with a band | sample: ±4 to ±7 % |
| a one-time exact median | partly: O1, 17 to 39 trips | partly | — | **covers** with O1 at the cut | no | **covers**: 1 to 3 trips | holder |

---

## 5. The pick, feature by feature

Decided as picked (V5-20 items 3 to 7), but for the compact hold in the first row's "Later", which V5-21 replaced with a compact backing inside `data`.

| Feature | First build | Later |
|---|---|---|
| `hold: 'all'`, a whole `connect()` | one `data` store at the asker (R0); the limit is `memory`, counted as RSS; warn at 80 %; refuse a hold at open that will not fit; end a live one `not-held` past the line and remove its rows; `data` 5 makes ordered views and quantiles chunked, lifts 2^24 a source, frees a dropped source | a compact backing inside `data`, turned on only by its author's explicit setting (V5-21 items 3 and 7; this page first said a compact hold for big resources with a fixed row shape); worker threads for live views |
| one-time code over every row | `scan()` at one cut, with an image budget and `scan-lost`; server root code and `ctx.data` loops read by scan, with no download | a pinned handle for two passes; a scan over threads |
| live code over every row | folds with fero's combines, served as a view; a merger audit | user combines behind the self-check; a tree over groups |
| live code that is not a fold | a hold under `memory` | a sized holder, if deployments need one |
| a live median or quantile | the sorted column at the merger, a part per group, exact | X4's histograms: approximate first, then the exact band; then the column can go |
| a one-time exact median | O1's selection at the scan's cut | X4's narrowing (1 to 3 trips) |

**Why one store at the asker, not one per group.** Stores by group make data's views cheaper by the number of stores (3.2), but only operators that merge can run per store, so `data`'s operators right of `connect()` would no longer all work over every row. A chunked index in `data` 5 makes each view cost about the sorted column's (872 to 1,107 ns a change at 1e6 values) on one store, and keeps every operator *(reasoned from the column's numbers)*. Stores by group stay the fallback if `data` 5 slips. Decided: `data` 5 fixes the views, and stores per group inside the asker are the measured fallback (V5-20 item 7).

**Why RSS, not live heap.** The box kills on RSS, and RSS ran 2.3 to 2.6 times live heap *(measured)*. Counting live heap would let a hold set to the box's RAM be killed at about 40 % of its "budget", before the warning.

**Cost.**

| Pick | Builder rules | User rules | `data` 5 items |
|---|---|---|---|
| the budget by RSS: the guard, its order with a server's `read-only`, `gc()` without a flag, which hold ends when several share it | +5 to +8 | +1 (net: replaces G5's ceiling rule) | +3 (chunked ordered views, chunked quantiles, free a dropped source) |
| lift 2^24 a source | 0 | 0 | +1: `data` 5 splits each source's key index into small tables (V5-21 item 2). This page also offered fero's stores by block (+2 to +4 builder); lifting the cap only with sources by block is rejected (V5-21) |
| `scan()` at one cut, with the image budget | +9 to +19 | +1 to +3 | 0 |
| folds with fero's combines and the merger audit | +4 to +6 | 0 to +1 | 0 |
| the sorted column at the merger | +3 to +5 | 0 | 0 |
| less MERGE's ceiling rule (G5) | −1 | — | — |
| **First build in all** | **+20 to +37**, about 4 to 8 % of 446 to 503 (the first build before V5-17's `past` reader; LAYERS 0.2 adds this to 449 to 506, now 500 to 592) | **+2 to +5** | **4** |

All *(reasoned)*. A leaner first build, a scan with no cut, is +15 to +27 builder rules.

---

## 6. What the API promises and states as a limit

**Promises.**
- `scan()`: every row once, at one cut by default (no commit shown in part; `cut: false` opts out, V5-20 item 4), at any number of rows; the asker's memory stays flat (groups × 2 pages).
- A fold: like any served view, at any number of rows, one cut, never back.
- A live median or quantile over every row: exact, with `data`'s quantile arithmetic, at one cut.
- `hold: 'all'` and a whole `connect()`: a sync `.value` of every row, live, at one cut, on any role (V5-16), while it fits `memory`.

**Stated limits** (API.md 7, SC-10).
1. "A whole-resource hold must fit this process's `memory`, counted as RSS: about 1.4 M rows of about 100 B a GB *(measured, X1)*. Health warns at 80 %; a hold that will not fit is refused at open; past the line the hold ends `not-held` and its rows are removed." (V5-20 item 3.)
2. "Every write to the resource is folded on this process's main thread. Its rate is set by the slowest live view on the hold: about 0.28 M writes a second with none (big frames), and until `data` 5, a few hundred a second with a top k over 1e6 rows and a few thousand with a median *(measured)*."
3. "A full collection of a hold pauses its process: about 1 s at 5e6 small rows *(measured)*. On a process that leads groups, health warns once a full collection there passes 0.5 s." (V5-20 item 8.)
4. "A scan's limit is time: about 0.8 M whole rows a second at one asker *(measured, X2)*. A scan at one cut keeps up to one before-image of each changed row on each copy until it ends; past the copy's image budget the scan ends `scan-lost`, never the writes."
5. "A fold's pieces stay small and its buckets are capped; a max or top k over many groups costs the merger about 18,000 to 26,000 writes a second at 256 groups, one write a frame *(measured, X3)*." The cap is stated: about 1.6e5 buckets at 16 groups, as for `derive`'s view form, with `derive`'s record form past it (V5-20 item 10).
6. "A live median over every row keeps one number a row of that field on one server: 12.8 B a value *(measured)*, within that server's `memory`."
7. "A median read once over every row takes 17 to 39 trips to every group *(measured, O1)*."

---

## 7. What changes in the decisions and pages (amended, never deleted)

V5-20 took the picks these amendments rest on. Its Consequences name the pages that change (MERGE.md, API.md 3.3 and 9, a new `scan()` and `fold` in API.md, LAYERS); the V5-20 rewrite makes the changes, and MERGE.md now carries its part.

- **MERGE.md 0 item 4, 5.4 item 1 and question 2.** The fixed one-process ceiling (about 1e6 to 5e6 rows) is superseded: a sync read of every row is bounded by `memory` (section 6, limits 1 to 3); one-time work, live folds and medians have no row ceiling (limits 4 to 7). MERGE question 2's "other way" (keep running with a warning) stays the other way of question 7 here.
- **MERGE.md 5.5, V5-14's frame.** "One store fed by slot stays only for `hold: 'all'`, a whole `connect()`, code over every row and a live median, under a stated ceiling" becomes: only for a sync read of every row and live code that is not a fold, under the asker's `memory`.
- **V5-13** (four read verbs: `get`, `connect`, `changes`, `past`): `scan()` is a fifth, for one pass over every row.
- **V5-14 pick 6** (`data` 5.0.0): four more items: chunked ordered views (`az`, `za`, `top`), chunked quantiles, free a dropped source, lift 2^24 a source. V5-21 item 2 says how the cap is lifted: each source's key index split into small tables.
- **V5-16 pick 2**: unchanged; `.value` stays the one sync read, now bounded by `memory`, not a row count.
- **GROUPS question 3** (a live view past the ceiling): a view that merges or folds has no ceiling; a hold past its line ends `not-held` (question 7 here).
- **GROUPS question 12 and API.md question 28** (servers that hold some groups): one-time root code and `ctx.data` loops read by `scan()`, on every server, a spare too, with no download; live code that folds runs as a served fold. Only a sync read of every row downloads what the server lacks, and it is bounded by that server's `memory`. MERGE 5.5's "code over every row downloads (R0) and keeps the ceiling" narrows to that case.
- **GROUPS G5 and G6.** G5's ceiling rule is replaced by limit 1; G6's fold rate is restated with views (limit 2).
- **API.md 3.3** (`hold`): add limits 1 to 3 beside the 80 % warning. **API.md 9** (`memory`): "this process's memory bound, counted as RSS; near it, whole-resource holds end first, then a server refuses writes `read-only`". One key, one meaning, one order of actions.

---

## 8. What is owed before the build

In order (sizes are guesses: S up to 2 days, M 3 to 5 days, L 1 to 2 weeks):
1. **The sorted column at the merger (M).** A part per group, replaced on a resync, values moved on a slot move, a loud remove; seeded, with planted bugs, in O1's world.
2. **The guard by RSS (S to M).** X1's seeded run with RSS as the measure; two holds and the app's own garbage in one budget; a long steady state near the line; how often it forces a collection.
3. **`data` 5's chunked views (M, in `data`).** `za` and `median` timed at 1e6 and 1e7 rows on one store, against the sorted column's numbers here. Owed (V5-20), with `data` 5's quantiles and lifted source cap.
4. **The scan's lease, `scan-lost` and image budget (M)**, and the pin on the wire (X2 owes it). Owed (V5-20).
5. **The merger audit for folds (S)**, run against X3's planted `nopair`, `resyncadd` and `mixver`. Owed (V5-20).
6. **The fold with a network decode (S).** 64 groups' frames of a few records each, decoded, into one store.
7. **X1's 2e7-row run of sources by block (S)**, if `data` 5 does not lift the cap. `data` 5 lifts it by splitting each source's key index into small tables (V5-21 item 2), so this run is needed only if that piece slips.

**Later:** X4 at real scale with groups on a network; a sample by row hash; the tree over groups; a compact backing inside `data` (V5-21, in place of the compact hold); the pivot tracker (3.8).

---

## 9. Questions for the owner, one at a time, most important first

The owner answered these on 2026-11-23, one at a time, in [V5-20](../DECISIONS.md): every question as picked but question 9, which V5-20 item 9 sent to a study ([COMPACT.md](COMPACT.md)) and [V5-21](../DECISIONS.md) then superseded. The questions stand as they were put; each now ends with what was decided.

1. **The limit for a sync read of every row: a row count, or the process's own `memory`?** Pick: `memory`, counted as RSS (about 1.4 M small rows a GB), warned at 80 %. Other way: MERGE's fixed ceiling (about 1e6 to 5e6 rows, 2^24 a source). **Decided:** the pick (V5-20 item 3).
2. **One-time work over every row as `scan()`, with no ceiling, in the first build?** Pick: yes; root code, `ctx.data` loops, `migrate` and `export` read by pages. Other way: keep them under the hold's `memory`. **Decided:** the pick: `scan()`, a new read verb, in the first build (V5-20 item 4).
3. **Live views on a big hold: fix them in `data` 5, or split the hold by group in fero?** Pick: `data` 5 (chunked ordered views and quantiles), so every operator still works over every row. Other way: one store per group inside the asker (23 to 25 µs a top 10 write at 64 stores), with only operators that merge. **Decided:** the pick; stores per group are the measured fallback (V5-20 item 7).
4. **Live code over every row as folds with fero's own combines, in the first build?** Pick: yes (+4 to +6 builder rules with the audit). Other way: all live code over every row runs as a hold under `memory`; folds later. **Decided:** the pick, with a merger audit that rebuilds the answer now and then (V5-20 item 5).
5. **A live median: exact on one server, or approximate with no values?** Pick: exact, a sorted column at the merger (12.8 B a value), with X4's histograms later. Other way: X4 first, within 1 % by default or as an opt-in, and its exact band when built. **Decided:** the pick; histograms per group come later (V5-20 item 6).
6. **The scan's promise: one cut or no cut?** Pick: one cut by default (+9 to +19 builder rules), since `export` and reports should not show half a commit. Other way: no cut first (+4 to +9), one cut later. **Decided:** the pick: one cut by default, `cut: false` opts out (V5-20 item 4).
7. **A hold that grows past its line: end it or keep it?** Pick: it ends `not-held` and its rows go; a hold that will not fit is refused at open. Other way: keep it with a health warning until the process runs out, as MERGE's question 2 offered. **Decided:** the pick; near the line, whole-resource holds end first, then a server refuses writes `read-only` (V5-20 item 3).
8. **A big hold on a process that leads groups (pauses past 1 s)?** Pick: allowed under `memory`, and health warns once a full collection there passes 0.5 s. Other way: refuse a whole-resource hold on a process that leads groups. **Decided:** the pick (V5-20 item 8).
9. **A compact store for big holds, later?** Pick: later, when a deployment asks, with sync reads and the merge classes only. Other way: never; big holds stay in `data`. **Superseded by V5-21.** V5-20 item 9 did not leave it to a later build by default: it asked for a study now of whether fero wants one and where it would sit, which is [COMPACT.md](COMPACT.md). V5-21 then decided: no compact store in the first build, which does six small things so one stays a cheap addition (item 1); when one comes, it sits inside `data` as a second backing, so every operator still runs (item 3), designed to cover servers' own rows too (item 6); and a resource turns to it only by an explicit setting its author chooses (item 7). A store of fero's own for big holds, with the merge classes only, is rejected.
10. **User combines in folds (sketches, custom pieces), later?** Pick: yes, behind the self-check at build and the audit, the classes with remove first. Other way: only fero's combines, ever. **Decided:** the pick: author-written combines come later, behind the build-time self-check and the audit (V5-20 item 5).
