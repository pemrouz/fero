# E-64 O2: derive from the change stream alone

**Question.** Can `derive`, and a served view over every row, be kept from changes alone, so that no process holds and folds the whole resource (TRANSFORMS' R0)? What must a change carry, how do exactly once and restarts work, what state is kept, and what does it cost?

**Short answer.** Yes for sums, counts and averages (per bucket or over every row) and for a top-k, if each change carries the fields the view reads **before** it as well as after it. No process then holds the resource's rows.
- **Where the before-image comes from.** A copy of each group already folds that group's records, and `data` hands every fold the row before it (`prev`). An enricher on that copy turns it into "before and after" of the named fields. It cost about 0.1 to 0.4 µs a record by the medians, inside the runs' spread *(measured)*.
- **Exact, in both forms built** *(checked)*. D1 (marks over ranges) passed 11 configurations of 1,000 seeds and 2 long runs; D2 (each share's partial, replaced on restart) passed 4 configurations of 1,000 seeds and a long run. That is through about 7,500 slot moves in each configuration with several groups, 3,775 to 60,307 runner crashes a configuration, late batches from dead runners, re-read items and one group down: 0 seeds wrong. Planted bugs failed 353 to 1,000 of 1,000 seeds, except one (D2 without its token: 2 of 1,000).
- **A top-k from changes needs a buffer and refills** *(checked; measured)*. Per share, 3 configurations of 1,000 seeds: 0 wrong; planted bugs 725 and 867. Refills are rare when scores grow, move a little or are drawn again (0 to 10 per 1e6 changes), and costly when the best row is often removed: 70 to 2,104 refills per 1e6 changes at 1e6 rows, each a scan of every row of the share (31 to 40 ms at 1e6 rows).
- **What one client sees** *(checked)*. With a view's buckets in one target partition (D1, P = 1), or with D2, the whole view is exact at one cut of the source. With buckets spread over 8 partitions, each partition is exact at its own cut, but 0.07 to 0.36 % of rows checked were counted twice or nowhere (a row moved between buckets in two partitions).
- **Cost per change** *(measured)*. A runner: 1.1 to 1.2 µs to decode an enriched item and 0.5 to 1.0 µs to fold it, holding no rows; R0's host: 0.85 to 0.88 µs to decode plus 1.7 to 2.7 µs to fold and keep the view, for every record of every group, holding 303 to 354 B a row. The before-image of two fields adds 13.9 B (25.6 %) to a 54.3 B record, if the log carries it.

## Words

- **Before-image.** The fields of a row as they were before a change. Here only the fields the view reads, such as the bucket and the value.
- **Enricher.** A `data` sink on a copy of a source group. `data` hands every fold its row deltas with `prev`, the row before the batch, by reference (data `contract/delta.ts`; E-54). The enricher turns them into one item per log entry: the slot, the slot's position, and for each changed row its key, its before-image and its after-image.
- **Share.** A fixed set of source slots (here slot mod S), as `consumer()` cuts them. **Runner**: the one process that owns a share at a time. It reads only its slots' items, from whichever group holds each slot, in each slot's order, and holds **no rows**.
- **Window.** The runner folds up to W items into one delta per bucket, then writes one **batch**.
- **Target.** The small resource that holds the answer: per bucket, an exact sum and a row count (an **accumulator**). The accumulator is a commutative group: E-57's exact sum (`WideSum`, checked in XB-4), which adds and subtracts exactly, with counts of `NaN`, the infinities and `-0` beside it. So deltas from many shares can land in any order and give the same bits.
- **D1, marks.** A batch carries a **mark** per source slot it covers: the range of positions, from and to. The target applies it only if its "from" equals what the target holds for those slots. A restart reads the marks and replays from them.
- **D2, replace.** The target holds each share's own partial (a depth-2 resource: a partition per share, a row per bucket) and the cut it stands at, under the share's **token**. A restart takes a new token, scans its share's rows at the copies, replaces the partial, and follows live changes from the scan's cut.
- **Buffer, refill.** For a top-k: every row of a share at or above a threshold, at most `kmax`; below k rows, a **refill** scans the share's rows at the copies.

## Method

All code is in `src/`, JavaScript run by Node 22.22.0, against data at `63fea66` (read only, imported from `../data` next to this repo) and fero v4's codec for byte counts (read only). The exact sum, the total order, typed bucket keys and the numeric projection are E-57 group B's (`../../E57-transforms/b-merge/src/lib.mjs`), already checked there.

**The world** (`src/world.mjs`). One source resource of 1,024 slots (E-57's count: fewer slots put more rows in each, the harder case) over G groups. Each group has a log and **one copy: a data store that holds only that group's slots' rows**, so no process holds every row. A write is a log entry of 1 to 3 records on one key (a whole row, an insert, a field write of the bucket, the value, the score or a field no view reads, a field delete, a row remove), in the dirty domain: bucket keys that mix strings and the numbers `1`, `2`, `3` with `'1'`, `'2'`, `'3'` (two buckets each), values that mix integers, two-decimal and very large or very small floats, `null`, strings, `-0`, `NaN` and the infinities. One move in 200 steps hands a slot to another group: a fence entry at the old group, an open entry with the rows at the new one; the copies drop and take the rows with the enricher off. The truth keeps each key's history by slot position, so a test can ask for the rows at any cut.

**D1 and D2** (`src/delta.mjs`, `src/sim-delta.mjs`). S runners keep a count-by and an exact sum-by. Each step: one source write; each runner reads 0 to 2 items from a random group and may flush its window; batches reach the target late and in order per runner (a random lag, so outboxes fill). Faults from the seed: a runner **crash** (1 in 400 runner steps: memory lost, the outbox's tail lost, part of it delivered later as a **zombie**), a **re-delivery** (1 in 300: a group's items read again from up to 50 back), slot moves. For D1 the target is one partition (P = 1, the whole view in one batch) or eight (P = 8, buckets hashed over partitions, each with its own marks). With `--down=1`, group 0 cannot be reached for the middle half of the run. **Oracle:** every 50 steps, and at the end after a drain, each target partition (D1) or each share's partial and their sum (D2) is compared with a pure count and exact sum over the true rows at that partition's or share's cut, written without data. The end state must be at the head of every slot. A seed fails on any mismatch. For P = 8 the run also counts **rows counted twice or nowhere**: a row whose bucket changed between two partitions that stand at different cuts.

**Planted bugs** (each must fail at least 100 of 1,000 seeds): D1 `nobefore` (the runner ignores the before-image), `nomark` (the target applies every batch), `memcursor` (a restart resumes from the runner's own last position, not the target's marks), `nofilter` (a restart sends replayed changes to every partition, not only those past each partition's own mark), `float` (float running sums, as `op.incr` gives today). D2 `nocheck` (neither token nor position is checked), `noreplace` (a restart keeps the stored partial and skips to the copies' cut), `nofence` (the token is not checked; the position still is). A control: `float` over integers only.

**T1, a top-k** (`src/topk.mjs`, `src/sim-topk.mjs`). `za('score', 10)` with ties by key, per share with a buffer (kp = 12 or 20, kmax = 2 kp), and the top 10 of the shares' answers. Faults: slot moves, a runner restart (1 in 4,000 runner steps: a refill). Oracle: after every 50 steps and at the end, each share's answer against the pure top 10 of its rows at its cut, and the merged answer against the pure top 10 of every row. Planted: `nodrop` (a buffered row that falls below the threshold stays), `norefill` (a short buffer is not refilled).

**T2, how often a buffer runs short** (`src/topk-rate.mjs`). One share of N rows (1e5, 1e6), numbers only, 1e6 changes, k = 10, kp = 12, 20, 50, 100, kmax = 2 kp. Workloads: `up` (a score only grows by 0 to 10: a points leaderboard), `walk` (moves by −10 to +10), `uniform` (drawn again from 0 to 1e6), `churn` (uniform, and 2 % of changes remove a row or add one), `topdel` (uniform, and 1 % of changes remove the current best row: an adversary, like a queue that takes its top). The buffer's top 10 is checked against a full sort every max(10,000, N/5) changes.

**Costs** (`src/bench.mjs`; three runs, each process alone under the timing lock, as a range). Rows of eight fields (about 100 B encoded, like E-54's); a mix of 25 % whole rows, 30 % value writes, 12 % bucket writes, 13 % score writes, 8 % writes of a field no view reads, 3 % field deletes, 9 % removes.
- `enrich`: a copy with 1e5 or 1e6 rows folds 1e6 records in lanes of 256 (as v5 folds a batch per call): plain, with a no-op data sink, and with the enricher. ns a record.
- `r0`: R0's way: one store with every row, plus a count-by and exact sum-by kept from data's deltas: the plain fold and the fold with the view, ns a record; heap a row.
- `runner`: the runner alone on 1e6 enriched items: ns an item to fold changes into its window and build batches, and the target's merge, ns a bucket delta; 100 and 10,000 buckets; windows of 64 and 1,024; exact and float sums.
- `scan`: a refill's scan at a copy: every row of a data store, keep the best 20. ms a scan.
- `bytes` (no timing): fero v4's codec, frames of 256: the log as is, plus the before-image of 2 fields (bucket and value), of 3 fields (and score), and of the whole row (E-54's measure).

To re-run: `./run.sh` (sims, topk, rate, bytes, timing, summary), or one part: `./run.sh sims`, `topk`, `rate`, `bytes`, `timing`, `summary`; `./run.sh quick` is a one-minute smoke test with no locks. `SP` names a scratch folder holding `bin/timing` and `bin/heavy`; without it the locks are skipped. `DATA` overrides data's folder.

## Results

### D1 and D2: count-by and exact sum-by from the change stream

Seeds of 1,500 steps (one source write a step), checked every 50 steps and at the end after a drain; long runs are one seed of 50,000 steps.

| form | groups | shares | P | domain | down | seeds | failed | checks | moves | crashes | zombies applied | refusals gap / dup / fenced | batches | bucket deltas | source changes | checks with partitions at different cuts | rows counted twice or nowhere (checks) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| D1 marks | 1 | 4 | 1 | dirty | no | 1,000 | 0 | 31,000 | 0 | 14,980 | 1,818 | 809 / 341 / 0 | 403,142 | 1,454,861 | 1,455,934 | 0 | 0 (0) |
| D1 marks | 1 | 4 | 8 | dirty | no | 1,000 | 0 | 31,000 | 0 | 14,924 | 45,368 | 15,081 / 2,381 / 0 | 1,561,132 | 1,295,548 | 1,455,934 | 30,000 | 6,406 (3,000) |
| D1 marks | 4 | 4 | 1 | dirty | no | 1,000 | 0 | 31,000 | 7,570 | 15,100 | 895 | 223 / 243 / 0 | 223,407 | 753,335 | 1,455,708 | 0 | 0 (0) |
| D1 marks | 4 | 4 | 8 | dirty | no | 1,000 | 0 | 31,000 | 7,570 | 15,027 | 9,933 | 1,771 / 656 / 0 | 800,057 | 713,894 | 1,455,708 | 30,000 | 1,719 (3,000) |
| D1 marks | 16 | 3 | 1 | dirty | no | 1,000 | 0 | 31,000 | 7,570 | 11,257 | 1,555 | 882 / 174 / 0 | 353,621 | 1,282,622 | 1,455,708 | 0 | 0 (0) |
| D1 marks | 16 | 3 | 8 | dirty | no | 1,000 | 0 | 31,000 | 7,570 | 11,334 | 45,366 | 15,114 / 2,671 / 0 | 1,365,691 | 1,099,006 | 1,455,708 | 30,000 | 5,985 (3,000) |
| D1 marks | 16 | 16 | 1 | dirty | no | 1,000 | 0 | 31,000 | 7,570 | 60,307 | 1,450 | 376 / 413 / 0 | 350,115 | 990,266 | 1,455,708 | 0 | 0 (0) |
| D1 marks | 16 | 16 | 8 | dirty | no | 1,000 | 0 | 31,000 | 7,570 | 60,073 | 6,397 | 1,625 / 728 / 0 | 1,136,644 | 980,790 | 1,455,708 | 29,997 | 1,320 (3,000) |
| D1 marks | 4 | 4 | 1 | float | no | 1,000 | 0 | 31,000 | 7,485 | 15,050 | 932 | 262 / 236 / 0 | 223,397 | 732,478 | 1,456,116 | 0 | 0 (0) |
| D1 marks | 4 | 4 | 1 | dirty | yes | 1,000 | 0 | 31,000 | 7,570 | 15,083 | 771 | 216 / 206 / 0 | 196,579 | 667,566 | 1,455,708 | 0 | 0 (0) |
| D1 marks | 4 | 4 | 8 | dirty | yes | 1,000 | 0 | 31,000 | 7,570 | 14,954 | 8,265 | 1,565 / 621 / 0 | 710,496 | 639,815 | 1,455,708 | 30,000 | 1,368 (3,000) |
| D1 marks | 4 | 4 | 1 | dirty | no | 1 × 50,000 | 0 | 1,001 | 261 | 492 | 0 | 0 / 0 / 0 | 802 | 2,668 | 48,095 | 0 | 0 (0) |
| D1 marks | 4 | 4 | 8 | dirty | no | 1 × 50,000 | 0 | 1,001 | 261 | 498 | 41 | 6 / 1 / 0 | 3,801 | 2,473 | 48,095 | 1,000 | 48 (100) |
| D2 replace | 1 | 1 | — | dirty | no | 1,000 | 0 | 31,000 | 0 | 3,775 | 145 | 1 / 0 / 635 | 249,562 | 1,266,182 | 1,455,934 | 0 | 0 (0) |
| D2 replace | 4 | 4 | — | dirty | no | 1,000 | 0 | 31,000 | 7,570 | 15,045 | 791 | 4 / 0 / 955 | 400,192 | 1,287,788 | 1,455,708 | 0 | 0 (0) |
| D2 replace | 16 | 3 | — | dirty | no | 1,000 | 0 | 31,000 | 7,570 | 11,191 | 678 | 3 / 0 / 1,024 | 414,455 | 1,433,592 | 1,455,708 | 0 | 0 (0) |
| D2 replace | 4 | 4 | — | dirty | yes | 1,000 | 0 | 31,000 | 7,570 | 15,121 | 725 | 4 / 0 / 716 | 330,351 | 1,058,075 | 1,455,708 | 0 | 0 (0) |
| D2 replace | 4 | 4 | 1 | dirty | no | 1 × 50,000 | 0 | 1,001 | 261 | 516 | 35 | 0 / 0 / 29 | 15,217 | 52,442 | 48,095 | 0 | 0 (0) |

Planted bugs (G = 4, S = 4), and one control:

| form | planted | P | domain | seeds | seeds failed |
|---|---|---|---|---|---|
| D1 | nobefore | 1 | dirty | 1,000 | 1,000 |
| D1 | nomark | 1 | dirty | 1,000 | 353 |
| D1 | memcursor | 1 | dirty | 1,000 | 920 |
| D1 | float | 1 | dirty | 1,000 | 1,000 |
| D1 | nofilter | 8 | dirty | 1,000 | 1,000 |
| D1 | float | 1 | int | 1,000 | 0 |
| D2 | nocheck | — | dirty | 1,000 | 528 |
| D2 | noreplace | — | dirty | 1,000 | 1,000 |
| D2 | nofence | — | dirty | 1,000 | 2 |

### T1: a top-k per share with a bounded buffer, and the merge of the shares

| groups | shares | k | kp | kmax | planted | seeds | failed | checks | changes | refills (of them restarts) | rows scanned by refills | largest buffer |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 4 | 4 | 10 | 12 | 24 | — | 1,000 | 0 | 31,000 | 1,384,982 | 7,038 (1,555) | 735,131 | 24 |
| 4 | 4 | 10 | 20 | 40 | — | 1,000 | 0 | 31,000 | 1,410,051 | 5,561 (1,555) | 553,283 | 40 |
| 16 | 3 | 10 | 12 | 24 | — | 1,000 | 0 | 31,000 | 1,418,601 | 5,299 (1,131) | 737,005 | 24 |
| 4 | 4 | 10 | 12 | 24 | — | 1 × 50,000 | 0 | 1,001 | 46,603 | 141 (54) | 19,303 | 24 |
| 4 | 4 | 10 | 12 | 24 | nodrop | 1,000 | 867 | 31,000 | 1,409,886 | 5,572 (1,555) | 554,665 | 24 |
| 4 | 4 | 10 | 12 | 24 | norefill | 1,000 | 725 | 31,000 | 1,410,304 | 5,555 (1,555) | 552,506 | 24 |

### T2: refills of a bounded top-k buffer (k = 10, kmax = 2 kp), per 1e6 changes

Each cell: refills per 1e6 changes; rows scanned per change in brackets. Every check of the buffer against a full sort passed unless marked.

| rows | workload | kp = 12 | kp = 20 | kp = 50 | kp = 100 |
|---|---|---|---|---|---|
| 100,000 | up | 0 (0) | 0 (0) | 0 (0) | 0 (0) |
| 100,000 | walk | 0 (0) | 0 (0) | 0 (0) | 0 (0) |
| 100,000 | uniform | 2 (0.2) | 0 (0) | 0 (0) | 0 (0) |
| 100,000 | churn | 10 (0.905) | 0 (0) | 0 (0) | 0 (0) |
| 100,000 | topdel | 698 (67.282) | 144 (13.961) | 29 (2.852) | 13 (1.274) |
| 1,000,000 | up | 0 (0) | 0 (0) | 0 (0) | 0 (0) |
| 1,000,000 | walk | 0 (0) | 0 (0) | 0 (0) | 0 (0) |
| 1,000,000 | uniform | 0 (0) | 0 (0) | 0 (0) | 0 (0) |
| 1,000,000 | churn | 0 (0) | 0 (0) | 0 (0) | 0 (0) |
| 1,000,000 | topdel | 2,104 (2,095.314) | 579 (576.554) | 155 (154.345) | 70 (69.705) |

### Bytes a record, fero v4's codec, frames of 256

| log as is | + before-image of 2 fields (user, cents) | + 3 fields (also score) | + the whole row before | records that need one | an enriched item (key, 2 fields before and after) |
|---|---|---|---|---|---|
| 54.3 B | +13.9 B (+25.6 %) | +23 B (+42.3 %) | +111.4 B (+205.3 %) | 85.1 % | 53.3 B |

### Timed costs (three runs, each alone under the timing lock; range over the runs)

A copy's fold, lanes of 256 records, ns a record:

| rows | plain fold | + a no-op sink | + the enricher | changes per record |
|---|---|---|---|---|
| 100,000 | 1085 to 1370 | 1026 to 1203 | 1299 to 1905 | 0.959 |
| 1,000,000 | 1817 to 2141 | 1793 to 2018 | 2115 to 2613 | 0.959 |

R0's way, one store holding every row, with a count-by and exact sum-by kept from data's deltas:

| rows | heap a row | fold, ns a record | fold and view | the view's share |
|---|---|---|---|---|
| 100,000 | 354 B | 1194 to 1398 | 1742 to 1852 | 343 to 658 |
| 1,000,000 | 303 B | 1903 to 1987 | 2579 to 2657 | 592 to 754 |

The delta runner, no rows held; 1e6 enriched items:

| buckets | window W | sum | runner, ns an item | target merge, ns a bucket delta | bucket deltas an item | batches an item |
|---|---|---|---|---|---|---|
| 100 | 64 | exact | 626 to 675 | 135 to 145 | 0.902 | 0.0156 |
| 100 | 64 | plain | 421 to 504 | 40 to 49 | 0.902 | 0.0156 |
| 100 | 1024 | exact | 481 to 592 | 172 to 294 | 0.098 | 0.001 |
| 100 | 1024 | plain | 365 to 393 | 62 to 67 | 0.098 | 0.001 |
| 10,000 | 64 | exact | 771 to 960 | 646 to 842 | 1.336 | 0.0156 |
| 10,000 | 64 | plain | 593 to 613 | 203 to 233 | 1.336 | 0.0156 |
| 10,000 | 1024 | exact | 740 to 948 | 536 to 803 | 1.249 | 0.001 |
| 10,000 | 1024 | plain | 528 to 633 | 172 to 248 | 1.249 | 0.001 |

A refill's scan at a copy (every row of a data store, keep the best kp = 20):

| rows | ms a scan | ns a row |
|---|---|---|
| 100,000 | 4.9 to 6.0 | 48.7 to 59.8 |
| 1,000,000 | 31.4 to 40.2 | 31.4 to 40.2 |

Decoding with fero v4's codec (frames of 256, each record made a plain object), ns a record:

| a record of the log (what R0's host decodes, every record) | an enriched item (what a runner decodes, its share only) |
|---|---|
| 852 to 882 | 1097 to 1180 |

One-minute load average at process start: 1.25 to 2.31.

What the tables say:
- **D1 and D2 were exact in every seed** (0 failed of 15,000 seeds and 3 long runs), with slot moves between up to 16 groups, runner crashes that lost the tail of their outbox, late batches from dead runners (145 to 45,368 a configuration still applied, each a valid next range; the rest refused), re-read items, and one group out for half the run.
- **Each rule is needed**: the before-image (`nobefore`, 1,000 of 1,000), the target's mark check (`nomark`, 353), a restart from the target's marks (`memcursor`, 920), the per-partition floor on restart when buckets spread (`nofilter`, 1,000), the exact accumulator for floats (`float`, 1,000; over integers it passes, 0, as it should), D2's checks (`nocheck`, 528) and its replace (`noreplace`, 1,000). D2's token alone (`nofence`) failed only 2 of 1,000 seeds, below the 100 bar: its position check refused every late delta; the token is needed only against a late **replace** from an older runner, which would roll the partial back.
- **Spreading a view's buckets over partitions has a visible price**: in every check after the start the partitions stood at different cuts, and 1,320 to 6,406 rows (in 3,000 sampled checks of about 600 rows: 0.07 to 0.36 %) were counted in two buckets or in none. D2 has no such case, because its partitions are cut by source slot, not by bucket.
- **The top-k buffer**: with kp = 12 a share of about 135 rows ran short about 800 to 1,800 times per 1e6 changes; with kp = 20, 4 times (T1, after taking away the first refill of each runner and its restarts). T2 shows the same at 1e5 and 1e6 rows, and that only a workload that removes the best row often keeps refilling.
- **Costs**: the enricher on a copy is close to the fold's own spread; a runner's decode plus fold (about 1.6 to 2.1 µs an item) is below R0's host's (about 2.6 to 3.5 µs a record), and a runner sees only its share. Coalescing in a window cuts bucket deltas to 0.1 an item when buckets are few (100, W = 1,024), and not at all when they are many (10,000: 1.25 to 1.34). The exact accumulator costs 0.1 to 0.6 µs more a bucket delta at the target than a float. An enriched item decodes slower than a log record (it is a nested object here; a flat form would be smaller and is not tried).


## What it means

- **"Derive from changes alone" works when the stream carries before-images, and the cheapest place to add them is where the rows already are.** No new state on the write path, no change to the log (D2, or D1 with a copy that rebuilds old before-images), and no process holding every row.
- **Two forms, two trade-offs.** D1 keeps one row per bucket and needs the before-images back to its marks after a restart: in the log (+13.9 B, 25.6 %, a record here, for a view that reads two fields) or rebuilt at a copy from a snapshot (not timed). D2 needs no history and no marks; a restart scans the share at the copies (tens of ms at 1e6 rows), and a reader adds S partials a bucket.
- **It is E-23's merger for windows**: a top-k per share, merged over the shares. Cutting partials by share of slots, not by group, removes E-23's rule 3 (pair the two halves of a slot move): one runner follows its slot to its new group and reads it in order.
- **It does not reach** `{ pages }`, quantiles, root operators, `hold: 'all'`, `ctx.data` over every row or `f.data.connect()`: those need every row, or every row's sort key, in one place.

## What this cannot show

- **No network, no Raft, no threads.** Groups are lists in one process, links are queues, a crash is a seeded event. A runner, the copies and the target are objects in one process.
- **D1's restart reads its items back from the start of each group's list**, as if the before-images were kept for as long as needed (the log form) or rebuilt at a copy. Neither the log form's real cost on disk nor a copy's rebuild from a snapshot was run; the bytes are measured on this mix only.
- **The marks are seeded, not model-checked.** D1's range marks and its per-partition floor are new rules; E-30's model and E-61 cover single-record marks.
- **One top-k field, one aggregate field.** `min`, `max`, filters before an aggregate, a filtered derived resource and pages from a re-keyed one are reasoned, not built.
- **Timing quality.** One 4-vCPU VM shared with other studies; the load averages are in the timing file. Differences inside the ranges are not claims.

## Files

- `src/lib.mjs`: the accumulator, the projection, the top-k order, the row generator, the pure count and sum.
- `src/world.mjs`: groups, copies on data, the enricher, moves, the truth.
- `src/delta.mjs`: D1 (`Runner`, `Target`), D2 (`RunnerB`, `TargetB`), their oracles.
- `src/sim-delta.mjs`: D1 and D2 seeded runs. `src/topk.mjs`, `src/sim-topk.mjs`: T1. `src/topk-rate.mjs`: T2.
- `src/bench.mjs`: the timed costs and the bytes. `src/summarize.mjs`: `results/summary.md`.
- `results/d.jsonl`, `t1.jsonl`, `t2.jsonl`, `bytes.jsonl`, `timing.jsonl`: one JSON line per run, each after a line with its command and load average.
