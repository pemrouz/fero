# E-65 X2: one-time work over every row, by a scan that never holds every row

**Question.** MERGE.md proposed a fixed one-process ceiling (about 1e6 to 5e6 rows, at most 16,777,216 rows a `data` source, about 0.28 M writes a second) for the whole-resource features the merger cannot split. Some of them do their work once: a read of every row, root code or a handler's `ctx.data` that walks every row, `migrate`'s scan, an export, a one-time median. This part asks: **can such work read every row once, page by page, from a copy of each group, so that no process ever holds every row? What can it promise while writes, slot moves and copy failures go on, what does each promise cost, and how fast is it at 1e7 rows over 16 groups?**

## The answer first

**Yes. One-time work over every row needs no row ceiling.** A scan reads every row once, in pages, from one copy of each group, all groups at once. The asking process keeps at most two pages a group asked for or unread, so its memory does not grow with the resource. The user's loop keeps only what it needs.

- **Memory.** At 1e7 rows over 16 groups, the asking process's heap peaked at 33 to 59 MB, whatever it scanned *(measured)*. No process held every row.
- **Speed** on one 4-CPU box, four server processes and the asker sharing it *(measured, ranges over the runs)*: whole rows 0.75 to 0.83 M rows a second (12 to 13 s for 1e7); one field with its key 2.1 to 2.4 M a second; one number field as raw numbers 16 to 20 M a second (0.5 to 0.6 s); a filter at the copies that passes 10 % looks at 6.8 to 7.9 M rows a second. With whole rows the asker's decode is the limit (1.26 to 1.38 µs a row).
- **Promises.** Three were built. The default, **one cut** (every row as it was at one pinned place per group, the pins paired with the slot moves), held in 0 of 4,700 seeds (0 failed of 14,100 over the three modes), with 0 torn commits of 1,119,674 multi-slot commits shown, through 179,649 slot moves and 76,185 copy failures *(checked)*. Every planted bug failed seeds; one of them is the first form of the pairing rule, which the seeded run found wrong.
- **Cost of one cut.** One pin entry in each group's log. Each copy keeps an **image** (the row as it was) of a pinned row the first time it changes: 127 B each *(measured)*. At 5,000 writes a second a group during a 12 to 14 s scan, that was 223,609 to 254,740 images over 16 groups, 28 to 32 MB over all copies *(measured)*.
- **Rules.** Builder rules +5 (4 to 9) with no cut, +11 (9 to 19) with one cut. User rules +1 (1 to 3) *(reasoned)*.

**Verdict.** A read of every row, root code and a handler's `ctx.data` that walk every row once, `migrate`'s scan, `export`, and a one-time exact median become a `scan()` read with no row ceiling. MERGE.md 5.4's one-process ceiling then covers only live work (`hold: 'all'`, a whole-resource `connect()`, live code over every row, a live median).

## Words

- **Slot, group, copy.** A slot is one of a resource's 4,096 fixed hash buckets. A group is one Raft log that owns some slots. A copy is one server's replica of one group: its rows in memory, by slot.
- **Scan.** A read of every row once, in pages, from one copy of each group, every group at once. The scanner (the asking process) keeps only where it is.
- **Session.** A copy's state for one scan of one group: the slot it is in and the last key it sent. It lets the scanner ask for pages ahead.
- **Credit.** How many pages of one group the scanner may have asked for, or be holding unread. A slow loop stops the asking: that is the backpressure.
- **Cursor.** The last key sent in a slot. Pages are cut in slot order, then key order, so a scan can go on at another copy, or at another group after a slot move, without repeating or skipping a row.
- **Floor.** The lowest log place a copy must have reached before it answers: the group's head when the scan began, and the highest place the scanner has seen of that group.
- **Pin, image.** A pin is a scan's mark at one log place of one group. From the pin on, the first time a row changes, the copy keeps the row as it was at the pin: an image. The image goes when the scan has passed the row or the pin ends.
- **Cut.** One log place per group. A scan "at one cut" hands on exactly the rows at those places.
- **Torn commit.** A commit of several rows that the scan shows in some of its rows and not in others.
- **Oracle.** The rows the scan should hand on, worked out from the world's own record of every write, by code that shares nothing with the copies or the scanner. **Planted bug**: a switch that breaks one rule on purpose, to show the oracle catches it.

## Three promises, built and checked

| Mode | What the scan promises | How |
|---|---|---|
| `none`: no cut | A row that existed for the whole scan is handed on exactly once; any other row at most once; each row handed on is one the key really had at some moment of the scan. A commit of several rows may show in part. | N1 the floor; N2 the key cursor; N3 a moved slot is followed to its new group with the same cursor. Nothing is kept on the copies but the session. |
| `slot`: a cut per slot | Each slot is handed on whole, as it was at one place of its own. Slots are at different places, so a commit over several slots may show in part. | The copy pins a slot when its first page is asked and keeps images while it is read (S1 the first change only; S2 a drop is a change); the scanner holds a slot's rows until the slot is done and starts it again if its copy fails (S3); S4 the floor. |
| `cut`: one cut for the whole resource | Every row exactly as it was at one place per group; each slot once; no commit torn; through slot moves and copy failures. | A pin entry in every group's log, so every copy keeps images (C1 the first change only; C2 a drop and an open are changes; C3 the pin is in the log, and a healed copy carries it with its images; C4 a copy answers only once it has applied the pin); C5 before any row is read, the slot moves are checked against the pins and any group on the wrong side of a move is pinned again; C6 unpin at the end. |

**C5, the pairing check, in full.** For each slot, `p` is the slot's highest position in any group's log up to that group's pin. Some group must hold the slot at `p` at its pin (it owns it, or fenced it and still keeps its rows); that group serves the slot. If none does, the group that has the slot now is pinned again. A group with a commit on the slot after its pin, at a position at or below `p`, is pinned again too, since that commit would be in the slot's rows but not in its own group's cut. Then check again. *The first form of this rule looked at the holders only; the seeded run found it wrong (see the results), and it is kept as the planted bug `oldpair`.*

## Results

The full tables are in [results/summary.md](results/summary.md), printed from `results/sim.jsonl` and `results/bench.jsonl`.

### Correctness: the seeded runs *(checked)*

**The real code, all three modes: 0 failed seeds of 14,100** (6,412,684 checks, six worlds). During the scans: 179,649 slot moves of three steps, 76,185 copy failures (26,762 of them under the scanner's own session), 51,990 `moved` answers followed.

| World | Seeds a mode | no cut: failed | cut per slot: failed | one cut: failed | one cut: re-pins | cut per slot: torn of multi-slot commits shown |
|---|---|---|---|---|---|---|
| default (4 groups, 64 slots) | 1,000 | 0 | 0 | 0 | 91 | 29,045 of 160,261 (18.1 %) |
| wide (8 groups, 256 slots) | 300 | 0 | 0 | 0 | 80 | 14,232 of 57,853 (24.6 %) |
| one group | 300 | 0 | 0 | 0 | 0 | 9,059 of 49,613 (18.3 %) |
| long (16 groups, 1,024 slots) | 100 | 0 | 0 | 0 | 124 | 16,823 of 38,918 (43.2 %) |
| stress | 2,000 | 0 | 0 | 0 | 1,194 | 58,535 of 754,645 (7.8 %) |
| hard | 1,000 | 0 | 0 | 0 | 859 | 23,063 of 231,560 (10.0 %) |

- **One cut tore no commit**: 0 of 1,119,674 multi-slot commits it showed. **A cut per slot tore 7.8 to 43.2 %** of them *(counted)*: its own promise holds (each slot whole), but a user cannot use it.
- **Every planted bug fails seeds.** In the `hard` world (1,000 seeds each) they failed 766 to 1,000 seeds, except `oldpair` (63); in the `default` world 0 to 1,000 *(checked)*. Per bug: [results/summary.md](results/summary.md).
- **The seeded run found a real flaw.** The pairing rule C5 was first written to look at the holders only. It failed 16 of 2,000 stress seeds: a slot moved away and back, one group's pin froze an old copy of it, and the scan read that copy while the other group's cut held later commits of the slot. The rule by position fixed it. The case is rare: 0 of 1,000 default seeds, 63 of 1,000 hard ones. The first form is kept as the planted bug `oldpair`.
- **The timed prototype's own check** *(checked: probe)*: during a 4e5-row scan at one cut with writes on every group, each group's sum equalled its sum at the pin (0 of 16 off). A writer that keeps no image made 16 of 16 differ; one that overwrites the image on every change made 16 of 16 differ ([results/probe-pincheck.txt](results/probe-pincheck.txt)).

### Speed and memory: 1e7 rows over 16 groups *(measured)*

Four server processes hold 16 groups (2.5e6 rows and about 1 GB of RSS each); one asking process scans every row over loopback TCP. Pages of 1,000 rows (4,000 for raw numbers), 2 pages of credit a group. Ranges over the timed runs. Every scan's check held.

| Scan | Seconds | Rows a second | Asker CPU a row | Servers' CPU a row (all four) | Asker heap at peak | Received |
|---|---|---|---|---|---|---|
| whole rows (JSON) | 11.98 to 13.42 | 0.75 to 0.83 M | 1,259 to 1,376 ns | 1,093 to 1,239 ns | 33 to 59 MB | 1,346 MB |
| one field with its key | 4.10 to 4.79 | 2.09 to 2.44 M | 422 to 491 ns | 298 to 397 ns | 38 to 45 MB | 161 MB |
| one number field as raw numbers | 0.51 to 0.61 | 16.2 to 19.6 M | 17 to 23 ns | 161 to 199 ns | 8 to 9 MB | 77 MB |
| a filter at the copies, 10 % pass | 1.27 to 1.47 | 6.8 to 7.9 M looked at | 126 to 143 ns | 225 to 267 ns | 31 to 39 MB | 135 MB |
| exact median (raw numbers, then a sort) | 1.36 to 1.60 | 6.2 to 7.4 M | 102 to 120 ns | 166 to 185 ns | 7 to 9 MB (80 MB of numbers off-heap) | 77 MB |
| whole rows, one group at a time | 12.97 to 14.41 | 0.69 to 0.77 M | 1,276 to 1,405 ns | 917 to 1,036 ns | 32 MB | 1,346 MB |
| whole rows, a `for await` per row | 13.88 to 17.33 | 0.58 to 0.72 M | 1,430 to 1,776 ns | 897 to 1,122 ns | 30 to 34 MB | 1,346 MB |
| whole rows, 2 asking threads | 7.34 to 8.50 | 1.18 to 1.36 M | 1,459 to 1,574 ns | 941 to 1,098 ns | RSS 448 to 495 MB | - |
| whole rows, 4 asking threads | 5.97 to 6.86 | 1.46 to 1.68 M | 1,424 to 1,615 ns | 834 to 971 ns | RSS 632 to 700 MB | - |

- **The asker's memory is flat.** Its heap peaked at 7 to 59 MB in every 1e7-row scan; a scan of whole rows moved 1.35 GB through it. A slow loop (about 2 µs of the user's own work a row, at 2e6 rows) ran at 0.36 to 0.38 M rows a second with a heap peak of 26 to 27 MB: credit stops the asking, and nothing piles up *(measured)*.
- **Page size and credit hardly matter past 1,000 rows and 2 pages** (2e6 rows): pages of 100, 1,000, 10,000 took 2.60 to 3.12, 2.51 to 3.14, 2.25 to 2.47 s; credit 1, 2, 8 took 2.37 to 2.51, 2.51 to 3.14, 2.46 to 2.54 s *(measured)*.
- **All groups at once only pays where the servers are the limit.** With whole rows the asker's decode is the limit: one group at a time was 7 to 8 % slower. With raw numbers, one group at a time ran at 4.7 to 6.0 M rows a second against 16 to 20 M at once *(measured)*.

### Writes during the scan *(measured)*

At about 5,000 writes a second a group (0.87 to 1.08 M writes during the scan), on the same 1e7 rows:

| Scan | Seconds | Writes during it | Images kept at peak (16 groups) | Check |
|---|---|---|---|---|
| no cut | 13.01 to 14.06 | 1,003,800 to 1,084,400 | 0 | - |
| one cut | 11.50 to 13.82 | 871,200 to 1,038,000 | 223,609 to 254,740 (28 to 32 MB at 127 B) | each group's sum equals its sum at the pin: 0 of 16 off |

The servers' CPU a row rose from 1.09 to 1.24 µs (no writes) to 1.50 to 1.85 µs, with the writes' own fold in it; the one cut cost the scan nothing it could see beside the no-cut scan *(measured)*.

### A server reading its own groups in place *(measured)*

One server process, 2.5e6 rows by slot, no wire: a plain walk of the maps 23 to 25 ns a row; the same rows in scan order (slot order, keys sorted, pages of 1,000) 101 to 113 ns a row (0.25 to 0.28 s), of which the sort is 64 to 79 ns; a `for await` per row 288 to 315 ns. So root code or a handler on a server reads its own groups at about 9 to 10 M rows a second, with no copy.

### What a pin costs a copy that folds with `data` *(measured)*

One group of 625,000 rows in a real `data` source, 200,000 field writes in batches of 256 through data's lane, with a sink that sees each row's `prev`:

| Mode | µs a record | Images kept |
|---|---|---|
| the lane alone | 1.71 to 1.96 | 0 |
| a sink that sees `prev` | 1.59 to 1.92 | 0 |
| a pin, half the rows already passed | 2.10 to 2.31 | 85,733 |
| a pin, no row passed yet | 2.04 to 2.17 | 170,990 |

Against the sink alone in the same run, a pin adds 0.15 to 0.51 µs a record, on the records that change a pinned row. An image costs 127 B of heap *(measured)*. A pin by copying the group's map of rows instead (rows shared, not copied) took 178 to 184 ms and 47 B a row (28 MB) up front *(measured)*.

## Method

- **The world** (`src/world.mjs`). S slots, G groups, three copies a group. A group is its log; each copy applies the log at its own pace (a follower lags up to 25 to 60 entries), holds its rows by slot, can fail (its local state is lost) and is replaced 5 to 30 steps later from a live peer's picture. Each step: 2 to 6 commits of 1 to 4 rows (20 % touch several rows, often in several slots of one group; 15 % of changes delete a row), now and then a slot move in three steps (fence at the old group, open at the new one 1 to 15 steps later with the rows and the slot's position, drop at the old one 1 to 15 steps after that; writes to the slot are refused between fence and open), and a copy failure. A slot's position counts the commits that touched it and is carried by a move (E-19). No network, no Raft: the log stands for a committed Raft log, a queue for a link.
- **The scanner** (`src/scan.mjs`). One page of P rows a step from a random group's chosen copy, while the world goes on; the cut mode's pins land 0 to 30 steps apart, as pins sent together arrive apart.
- **The oracle** (`src/sim.mjs`). It keeps every key's history by slot position and by step, and every commit that touched two or more slots. `none`: no key twice; every key that existed for the whole scan handed on; each row handed on is, by identity, one the key had at some step of the scan. `slot` and `cut`: each slot handed on once, equal as values to its rows at the position the scanner reports, at or past the slot's position when the scan began; `cut` also: no commit torn. `slot` counts torn commits as a measure.
- **Worlds.** `default` (4 groups, 64 slots, 800 keys), `wide` (8, 256, 3,000 keys, pages of 8), `one` (1 group, no moves), `long` (16 groups, 1,024 slots, 20,000 keys, pages of 16), `stress` (2 groups, 16 slots, 200 keys, 6 commits a step, frequent moves and failures, pins 30 steps apart), `hard` (2 groups, 4 slots, 120 keys, pages of 2, a move every 3 steps, a copy failure every 5): each planted bug's case comes often in `hard`.
- **Planted bugs.** `none`: `noseen` (no floor), `nofollow` (a moved slot taken as done), `restart` (a slot starts again after a copy failure), `maporder` (pages by the copy's own order and a count, not by key). `slot`: `noseen`, `nobuffer` (rows handed on as they come), `dropnosave` (a drop keeps no images), `everysave` (every change overwrites the image). `cut`: `nopair` (no pairing check), `oldpair` (its first form), `dropnosave`, `opennosave`, `everysave`, `localpin` (only one copy keeps images), `pinnotcarried` (a healed copy gets the pins without images), `nofloor` (a copy behind the pin answers).
- **The timed prototype** (`src/server.mjs`, `src/client.mjs`, `src/bench-scan.mjs`). Four server processes hold 16 groups of a 1e7-row resource (groups g with g mod 4 = w on server w, 2.5e6 rows each, about 1 GB of RSS each), rows by slot in a `Map` per slot (the "rows by slot" GROUPS G7 asks of `data` 5; plain Maps stand in), E-05's small row (about 114 B as JSON). One asking process opens a TCP link to each server and a session per group, and asks pages with credit; the user's loop is `for await (const [g, page] of scan.pages()) for (const row of page)`. The check: every scan with no writes sees exactly the servers' rows and their sum (and the count of a filter, and the exact median from the servers' counts per value); with writes and pins, each group's sum equals its sum at the pin. CPU is `process.cpuUsage` of the asking process and of the four servers; memory is the asking process's heap and RSS sampled every 20 ms.
- **The copy-side cost** (`src/bench-local.mjs`). A server reading its own groups (2.5e6 rows) three ways; and a pin on one group of 625,000 rows held in a real `data` source (`../data`, read only), written by field updates in batches of 256 through data's lane, with a sink that sees each row's before (`prev`).
- **Timing.** Three runs, each run one hold of the timing lock (alone on the box); the scan bench's parts each in a fresh process. A cell is the range over the runs. Seeded runs under the heavy lock. Node 22.22.0; one 4-vCPU box with 15 GB, shared with other studies' jobs between holds; load at the start of each process is in the results.
- **Scaled.** Every process stayed under 4 GB: the 1e7 rows are spread over four server processes of about 1 GB each; the sweep ran at 2e6 rows; the pin bench used one group of 625,000 rows.

## Verdict

**Use a scan for one-time work over every row, with no row ceiling, at one cut by default.**

- It covers what MERGE.md 5.4 item 1 put under a fixed one-process ceiling when the work is done once: a read of every row, root code and a handler's `ctx.data` that walk every row, `migrate`'s scan, `export`, and an exact one-time median or quantile. The ceiling then covers only live work (options X1, X3, X4 of E-65).
- One cut is worth its price. It is the only one of the three promises a user can state in plain words (every row as at one place per group, no commit torn), it held in every seed, and its cost is one log write per group plus an image of each pinned row that changes, at most one per row.
- No cut stays as the cheap opt-out (`cut: false`), for `migrate` and for scans that only count or look for something. A cut per slot lost: it costs nearly what one cut costs and still tears 8 to 43 % of multi-slot commits.
- The verb is a new read verb, `scan()`, beside `get()`, `connect()`, `changes()` and `past()`, since reads differ by verb (V5-13). Its row form is the simple one; a page form and a raw-numbers form serve hot loops.

## Limits

- **No network and no Raft in the seeded runs.** A group is its log; a copy applies it at its own pace; a link is a step. The pin's log write, a leader's answer for the pairing check, and the healing picture are stand-ins.
- **The timed runs are on one box.** Four server processes and the asker share 4 CPUs over loopback TCP. On real machines the asker's decode stays its limit, the servers' CPU is spread, and the wire adds a limit: a 1e7-row scan of whole rows moved about 1.35 GB, about 11 s at 1 Gbit/s alone *(arithmetic)*.
- **Rows by slot are plain `Map`s**, standing in for the "rows by slot" GROUPS G7 asks of `data`. The sort of a slot's keys is the prototype's own.
- **The timed pin is local to one copy**, with images dropped once passed. The pin in the log (every copy keeps images) ran only in the seeded world; its cost on the other copies is the pin bench's rows times the number of copies, by arithmetic.
- **Not built:** the lease that ends a pin left by a dead scanner, an image budget per copy, the `scan-lost` error, the pairing check's wire form, a resumable scan, a cut by writer time across groups.
- **Faults are drawn, not exhaustive.** No model checker ran the pairing rule; its first form passed 1,000 default seeds and failed only in the stress and hard worlds.
- **One row shape** (E-05's, about 114 B as JSON) and one write mix (one field rewritten, uniform keys) in the timed runs.
- **Load.** Each timed run held the box alone. The load average at each process's start (1.96 to 4.99) is in `bench.jsonl`; it lags, and mostly shows the jobs that had just ended. Run 1's pin part was timed again on its own after a fix to that bench (an older form counted too few images); its old rows were dropped.

## Files and how to rerun

- `src/world.mjs` the seeded world (groups, copies, three-step moves, failures, pins); `src/scan.mjs` the scanner in its three modes; `src/sim.mjs` the seeded run and its oracle; `src/lib.mjs` helpers.
- `src/server.mjs` a server process (groups by slot, sessions, pins, a writer); `src/client.mjs` the asking side (links, sessions, credit, `pages()` and `rows()`); `src/scan-worker.mjs` one asking thread of several; `src/bench-scan.mjs` the timed scans; `src/bench-local.mjs` a server's own read and the pin's cost on `data`; `src/pinmodel.mjs` a pin's memory by arithmetic; `src/summarize.mjs` the tables.
- `results/sim.jsonl`, `results/bench.jsonl`, `results/summary.md`.
- `./run.sh quick` (a smoke run, a few minutes, writes nothing; it passed under the heavy lock: 19 seeded runs and 5 timed scans, every planted bug caught), `./run.sh sim`, `./run.sh bench`, `./run.sh summary`, `./run.sh` (all). `SP` names a folder holding two lock wrappers, `bin/heavy` and `bin/timing`; without it the locks are skipped. `DATA` overrides `data`'s folder (default `../data` next to the repo).
