# E-57: transformations, built small

**Question.** On 2026-11-20 the owner asked for a fully developed, validated plan for how transformations can work, since they brought much complexity into earlier versions, and asked whether data needs a new version. A plan was written for every way code turns rows or records into something derived: operators, views over a partition or over the whole resource, where they run, joins, transforms of the log, and views of the past. A critic attacked it and added claims of its own. E-57 asks: **built small on data's real engine and checked by seeded oracles with planted bugs, does each claim of the plan, and each of the critic's, meet its bar? What does each piece cost? And does anything here ask for a rewrite of data, or for Rust?** The page built on these results is [TRANSFORMS.md](../../TRANSFORMS.md).

**Short answer.** The design holds, with changes. **Served views** (a view the server names in `methods:`) and **pushdown** (a plain chain run on a copy) equalled their query run from scratch after every frame in every seeded run on the final code, through disconnects, copy kills, leader kills, restarts from a snapshot and rolling deploys, once eight rules the plan had not written were added. **Across partitions, one data store fed by slot is enough**: no merger, 19,167,410 checks, 0 mismatches through 6,122 slot moves. The **new operators**, the **contract fixes**, the **live lookup join**, **views of the past** and the **record form's mark** each passed. **`derive`'s view form failed as the plan wrote it** (796 of 1,000 seeds) and passed with the critic's three fixes. Three bars were missed: **building a served view over 1e6 rows stalls its copy** for 0.2 to 1.9 s, because data cannot build in slices (XA-1); **failover can still refuse a client that held a view** after two failures (XA-2, 1 seed of 1,000); and the **O(log N) index for a leaderboard** costs 9.5 to 15.1 µs a sort-field write at 1e6 rows against a guessed 3 µs, though it is 86 to 146 times cheaper than today (XB-1). Every piece was built on data 4's public API in JavaScript: **nothing asks for a rewrite of data's engine or for Rust**, but several pieces change answers, so they belong in a breaking data 5.0.0.

**Words.** A **row** is one entry of a resource; a **partition** is the rows one leader keeps in one order. A **slot** is one of a resource's fixed hash buckets; a **group** is one log that owns some slots. A **copy** is a server that holds a full replica. A **view** is a live answer data keeps up to date from rows. A **served view** (class C) is a view a method declares with `{ view }`, kept on a copy and shared by every equal call; **pushdown** (class B) is a plain chain of operators run on a copy over one partition; **class A** sends the partition and runs the chain on the client. A **frame** is one commit's changes to one view; a **picture** is a view's whole value, sent when a link starts or cannot resume. The **order channel** is data's record of where each row sits in an ordered view. A **deriver** keeps a target resource equal to a view of a source (`derive`'s view form). An **oracle** is the same query run from scratch on the true rows, by code that does not use data. A **planted bug** is a switch that breaks one rule on purpose, to show the oracle can fail.

**Marks.** *(measured)*: timed, three runs, each process alone on the box under the timing lock; the range over the runs. *(checked)*: a seeded run, a model or tsc ran it, and its line is in a `results/` folder. *(reasoned)*: an argument, not run. *(a guess)*: nobody measured it.

## The parts

| Part | What it is | Its README |
|---|---|---|
| [a-served/](a-served) | a copy with served-view entries, class B and class A (`proto/served.mjs`), a client with the order channel that applies every picture as one commit of differences (`proto/client.mjs`), a pure oracle with an exact BigInt sum (`proto/oracle.mjs`), a seeded world of three copies with their own lags and faults (`sim/`), benches (`bench/`), a type sketch (`types/view.ts`): about 2,000 lines. data is imported from its TypeScript source with Node's type stripping, through E-55's prototype (`D`, `SourceNode`) | [a-served/README.md](a-served/README.md) |
| [b-merge/](b-merge) | one data store fed by slot (`src/store.mjs`), the contract and the new operators on data's public API (`src/ops.mjs`, `src/lib.mjs`), a chunked ordered index (`src/index.mjs`), the lookup join (`src/lookup.mjs`), seeded sims (`sim/`), E-30's model extended (`models/derived2.py`), benches (`bench/`): about 2,800 lines. data is bundled once with esbuild | [b-merge/README.md](b-merge/README.md) |

Both parts ran on Node 22.22.0 and data 4.0.0 at commit `63fea66` (read only), on a 4-CPU box shared with another study ([a-served/results/versions.txt](a-served/results/versions.txt), [b-merge/results/versions.txt](b-merge/results/versions.txt)). Group A also used tsc 6.0.2; group B esbuild 0.25.12 and Python 3.13. Nothing in data, E-55 or E-30 was changed.

## How each claim was measured

- **The oracle.** After every frame, picture, resume answer or `SYNC` answer a client applies (group A), and after every entry a store takes, every commit, step or idle point (group B), the live answer must equal the same query run from scratch on the true rows at that position, by code that does not use data. Ordered answers are compared as key sequences, sums exactly (a BigInt sum in group A, a BigInt-rational oracle in XB-4), buckets as maps. The true rows come from an independent fold of the log, never from the store under test.
- **Seeds.** Every run takes a seed; the same seed gives the same run. 1,000 seeds per claim unless the claim says otherwise. Faults are drawn from the seed: disconnects, copy kills, leader kills, restarts from a snapshot, deploys and rolling deploys (group A); lags of up to 100 entries, resumes, pictures, rebuilds, slot moves, group grows and shrinks, deriver pauses and kills, log cuts, late pictures (group B).
- **Planted bugs.** Each claim names at least one bug, planted by a switch (`E57_MUTATE` in group A, `MUTATE` in group B) and run on the same seeds. A claim passes only if its real code has 0 failures and each planted bug fails at least 100 of 1,000 seeds. Two claims were planted by design: XA-8's impure view is itself the bug, and B5's planted mark is a model option.
- **Models.** B5 runs E-30's model, imported unchanged and widened to two outputs of one record in one slot, on E-16's engine: every bound, the planted mark, and the order rule dropped.
- **Types.** XA-11 is a tsc check: three `@ts-expect-error` lines must compile marked and fail stripped.
- **Timing.** Every timed number: three runs, in each of which every process ran alone on the box under the timing lock, after a full collection; inside a process the ways interleave round by round and a cell is the median of 3 or 5 rounds. Load averages at process start were 1.00 to 2.19 (group A) and 1.01 to 2.87 (group B) *(checked: the `loadavg` fields of both `timing.jsonl` files)*. Seeded and heavy runs ran under the heavy lock. Every process stayed under 4 GB (`--max-old-space-size` of 3,000 or 3,500); the largest, XB-1 at 1e6 rows, peaked near 2.5 GB.

## Results: the claims

Group A, served views and pushdown. Raw lines: [sims.jsonl](a-served/results/sims.jsonl), [mutants.jsonl](a-served/results/mutants.jsonl), [timing.jsonl](a-served/results/timing.jsonl), [types.jsonl](a-served/results/types.jsonl); every table also in [summary.md](a-served/results/summary.md).

| # | Claim | Bar (short) | Result | Verdict |
|---|---|---|---|---|
| A1 | a served view, end to end | 0 unequal in 1,000 seeds for a window, buckets, a scalar and a page; one encode per change for 1 and 1,000 subscribers | 144,843 checks (131,974 frames, 12,869 pictures), 0 unequal; 277 frames, 277 encodes (1 subscriber); 288 frames, 288 encodes, 288,000 sends (1,000) | pass |
| A2 | resume after a reconnect | 0 doubled, missed, unequal or back in time over 4,000+ disconnects, 1,000+ ring resumes and pictures | 12,870 disconnects, 6,166 ring resumes, 5,909 resume pictures: all 0 | pass |
| A3 | failover | 0 unequal, 0 back in time, a kill in every seed, builds from a snapshot | 5,371 kills (2,413 of the leader), 22,040 pictures, 16,139 builds on copies restarted from a snapshot: all 0 | pass; a leader change is **not** invisible with voters only (608 to 3,644 hand-offs per 1,000 seeds) |
| A4 | sharing; `allow` on every SUB; no caller in a view | builds = distinct keys; 0 frames to a refused caller | 2,000 subscribers over 25 keys written in both key orders: 25 builds; 3,188 denials, 0 frames to them; tsc refuses `ctx.claims` | pass |
| A5 | caps and bounds | each refusal exactly when an independent count says | 28,211 admissions, 0 mismatches, 0 over a cap, 4,840 refusals, 1,139 `view-too-big` ends, 0 sink calls after an end. A real bug found first (a `get()` moved a count), fixed | pass, after the fix |
| A6 | linger, dispose order, handler views | 0 rebuilds in the linger, 0 sink calls after dispose, 0 live data views at the end | 3,124 reuses in the linger; 0 calls after dispose; 0 entries and 0 data views at the end; 3,559 handler calls, 0 wrong | pass |
| A7 | class B with the order channel, through resumes and the fallback | 0 unequal; 1,000+ resumes; 100+ fallbacks | 79,209 checks, 0 unequal; 5,444 ring resumes, 9,428 resume pictures, 4,554 fallbacks to class A | pass |
| A8 | a redeploy | 0 frames from an old-version view | 1,000 deploys, 1,365 entries ended `redeployed`, 0 old frames, 0 unequal | pass |
| XA-1 | builds never stall long; no leader serves | stall ≤ 50 ms (a guess) at 1e6 rows; 0 views on a leader | 0 entries on a leader in every run; stalls at 1e6 rows 0.49 to 1.9 s in one block, 0.21 to 0.24 s sliced | **miss** at 1e6; the leader part passes |
| XA-2 | one copy per view, by hash; failover refuses no holder | builds = distinct keys; 0 holders refused after a kill | 50 builds for 50 keys; deterministic kill: 0 refused; seeded: **1 holder refused in 1,000 seeds** after two failures in one linger | **miss** (1 of 1,000) |
| XA-3 | an instance names one view across copies | 0 frames from another instance | 0 in every run (instance = copy, incarnation, counter) | pass |
| XA-4 | a new picture is one commit of differences | one sink call; previous + diff = new | 0 violations at every picture in every run | pass |
| XA-5 | `c` carries order changes | a list rebuilt from `c` alone equals the order | 0 unequal in every run | pass |
| XA-6 | operators right of a served ordered view keep its order | `map`, `filter` after `best(10)` in order | 0 unequal over 37,076 (a3) and 68,296 (a1) checks, on an ordered mirror built outside data | pass |
| XA-7 | pages share one index; never refused | ≤ 1 index for 1,000 page reads; 0 refusals | 1 index, 0 refused, 0 unequal | pass |
| XA-8 | purity matters | an impure view differs after failover in 100+ seeds | 822 of 1,000 differ; with one fixed clock, 0 of 1,000 | pass |
| XA-9 | the cap bounds cost | refusals equal an independent cost sum | 31,454 admissions, 845 refused, 0 mismatches | pass, on a guessed cost model |
| XA-10 | a rolling deploy never goes back in version | 0 v1 pictures after v2; a stale typed client is refused | 3,000 deploys with kills: 0 back; 2,751 `stale-client`. The first run failed 15 of 1,000 seeds until a client-side floor was added | pass, with the client floor |
| XA-11 | a view over two resources is refused | tsc refuses `lookup`, `use`, `claims` in a `{ view }` | exit 0 marked; stripped, each fails TS2339 | pass (types only) |
| XA-12 | `view-too-big` does not loop | built at most once per deploy; warns at 80 % | 1,641 too-big ends, 0 rebuilds after; the warning fired | pass |
| XA-13 | read-your-writes through `SYNC` | the answer is at or past the write | 1,965 `SYNC`s, 0 failures | pass |
| XA-14 | the view selector model-checked | E-31's bounds | not run: a separate model-checking job | **not run** |

Group B, across partitions, resources and time. Raw lines: [b1.jsonl](b-merge/results/b1.jsonl), [b1-seeds.jsonl](b-merge/results/b1-seeds.jsonl), [b2.jsonl](b-merge/results/b2.jsonl), [b3.jsonl](b-merge/results/b3.jsonl), [b4.jsonl](b-merge/results/b4.jsonl), [b5-model.txt](b-merge/results/b5-model.txt), [b6.jsonl](b-merge/results/b6.jsonl), [xb.jsonl](b-merge/results/xb.jsonl), [timing.jsonl](b-merge/results/timing.jsonl); `node b-merge/summarize.mjs` prints them in short.

| # | Claim | Bar (short) | Result | Verdict |
|---|---|---|---|---|
| B1 | one store fed by slot (R0, R1, R2): views over every row stay exact | 0 mismatches over 1e5 commits for G = 1, 4, 16, elastic; 1,000+ slot moves, some while 100 behind | 19,167,410 checks, 0 mismatches; 6,122 moves of 138,843 slots; 23,498 opens taken while behind; two stores in other orders agreed at all 204 sync points | pass (G = 1 has no moves) |
| B2 | the new operators | 0 mismatches, value domain 10; page joins equal; `by().sum()` flat within 1.5x from 1e4 to 1e6 | 4,085,362 checks, 0 mismatches; 99,435 page walks equal the whole list; `by().sum()` 0.66 to 1.84 µs, flat within noise | pass |
| B3 | `derive`'s view form converges | 0 unequal at idle; 0 stale writes; 3+ deriver changes a seed | as the plan wrote it: **796 of 1,000 seeds fail**; with bump, read barrier and code version: 0 of 1,000 (79,333 idle checks, 11,810 deriver changes, 7,475 starts after a log cut) | **miss as planned**; pass with XB-8, 9, 10 |
| B4 | a live lookup join | 0 unequal; links = keys named; 0 after the end | 537,670 checks, 0 unequal, 0 link errors; 97,836 trips, one per new key | pass |
| B5 | the record form's mark carries the write number | every bound; planted gives a counterexample | 12 of 12 bounds hold; the planted mark and the dropped order rule each break LOST | pass; full ablation not run |
| B6 | views of the past | 0 unequal; one sink call a step | 41,000 checks, 0 unequal, 0 extra sink calls | pass, with XB-12's rule |
| XB-1 | an O(log N) index for a leaderboard | ≤ 3 µs a sort-field write at 1e6 (a guess); exact | 9.5 to 15.1 µs (today 1,305 to 1,385); build 0.69 to 0.80 s (today 3.40 to 3.59 s); exact in 1,000 seeds | **miss** on cost at 1e6; pass on build and correctness |
| XB-2 | the total order holds in both directions | no non-number in a window while ten numbers exist; UTF-16 ties | 979,098 checks, 0 mismatches | pass |
| XB-3 | one numeric projection for every aggregate | six aggregates equal one pure query | 1,200,000 checks, 0 mismatches | pass |
| XB-4 | the exact sum over every finite double | 0 mismatches over 1e6 steps; ≤ 2x E-23's cost | 1,000,000 checks, 0 mismatches; 8 of 8 edge histories; 0.88 to 1.22x | pass |
| XB-5 | typed bucket keys; SameValueZero | `by`, `eq` equal the typed rule | 1,800,000 checks, 0 mismatches | pass |
| XB-6 | depth 2 ties and pages by (partition, row) | compared by key path | 400,000 checks, 0 mismatches | pass |
| XB-7 | paging across cuts | each unchanged row seen once | 984,927 stable rows, each once; 80,302 changed rows reported | pass |
| XB-8 | a takeover raises the fence at every target group | 0 stale writes after a takeover | 0 after the bump reached a group; 1,389 in the gap before it, all repaired | pass as restated (the bar as worded cannot hold for any fence carried by a message) |
| XB-9 | the read barrier removes the step back | 0 step-backs | 0 | pass |
| XB-10 | a deriver never hands the target back to older code | never v1 after v2 | 0 | pass |
| XB-11 | `lookup` tells loading from none | `undefined` only before the first picture; `null` after a remove | 0 of 1,000 seeds fail | pass |
| XB-12 | a past view across a fold-version change equals the live fold | with both builds loadable | 0 unequal; `old-fold` right at 94,323 positions; the plan's rule would have refused 60,000 answerable ones | pass; the 1e5-changed-row seek not run |
| XB-13 | `limit` over an ordered parent is a window | `za(f).limit(n)` = `za(f, n)` | 200,000 checks, 0 mismatches for a `limit` that reads the order channel; data's `limit` today fails 1,000 of 1,000 | pass for the prototype; data must change |

## Results: what it costs

All *(measured)*: three runs, each process alone under the timing lock, ranges over the runs. "Per change" is time with the view minus the same writes without it.

**A served view on its copy** (group A, `bench/copycost.mjs`; rows `{ id, points, pts, team, name }`, `points` with a value domain of 10; the cost includes data's fold of the change, the view and the frame's one encode):

| View | 1e3 rows | 1e4 rows | 1e5 rows | Bytes per frame | Picture bytes |
|---|---|---|---|---|---|
| `best(10)`: data's `az` with ties by key, a window of 10 | 5.7 to 6.2 µs | 17.4 to 19.1 µs | **134 to 148 µs** | 135 to 137 B | 884 to 936 B |
| `after(cursor)`: a filter, then a window of 20 | 4.2 to 5.1 µs | 4.1 to 5.0 µs | 12.5 to 13.3 µs | 136 to 138 B | 1,716 to 1,805 B |
| `byTeam`: an exact sum per bucket (prototype) | 3.7 to 4.5 µs | 3.7 to 4.0 µs | 4.6 to 4.9 µs | 64 to 66 B | 167 to 174 B |
| `total`: one exact sum (prototype) | 1.8 to 2.6 µs | 2.4 to 2.5 µs | 3.2 to 3.5 µs | 56 to 65 B | 87 to 99 B |

**Builds and the stall they cause** (group A, `bench/rebuild.mjs`; the longest event-loop stall during the build, a 1 ms ticker):

| View | Build at 1e5 | Build at 1e6 | Stall at 1e6, one block | Stall, slices of 20,000 rows: 1e5 / 1e6 |
|---|---|---|---|---|
| `best(10)` | 90 to 97 ms | 1,440 to 1,521 ms | 1,495 to 1,893 ms | cannot be sliced from outside data |
| `byTeam` | 32 to 38 ms | 643 to 720 ms | 649 to 741 ms | 15 to 16 ms / **211 to 231 ms** |
| `total` | 30 to 35 ms | 498 to 523 ms | 493 to 498 ms | 15 to 16 ms / **222 to 240 ms** |

The sliced builds stall at 1e6 because data has no resumable key iterator: the one way to list keys copies the store in one block *(checked: data kernel/store.ts `snapshot`)*.

**Other served-view costs** (group A): a ring resume of 8 missed frames at 1e4 rows costs the copy 1.4 to 1.7 µs against 5.8 to 6.2 µs for a picture (`best(10)`), but for small bucket views the ring answer is bigger (543 B against a 179 B picture). A join of one more subscriber: 2.0 to 2.1 µs plus 4.4 to 5.2 µs to encode its picture; 496 B per subscriber. A served `best(n)` holds 1,083,503 B at 1e4 rows and 9,061,610 B at 1e5, whatever n is. A page read over one shared index: 32 to 33 B and 10 to 16 µs; one entry per cursor instead: 0.72 MB a page at 1e4 rows, 8.3 MB at 1e5. The size check against `views.rows`: 10.4 to 12 ns per entry per commit.

**Class B against class A** (group A, `bench/classb.mjs`; S shapes of `gt('points', t).za('points', 10)` on one partition): the copy pays 1.2 to 3.2 µs per shape per change for class B; the client pays 1.3 to 5.0 µs for class A. Bytes per change: class B 0.1 to 28 B for all shapes, class A 108 to 113 B.

**The leaderboard index** (group B, `bench/xb1-cost.mjs`; `za(10)` over every row, data today in brackets):

| Rows | Sort-field write, one commit each | In batches of 256 | Other-field write | Build |
|---|---|---|---|---|
| 1e4 | 2.4 to 3.7 µs (19.3 to 20.8) | 1.0 to 1.1 µs (6.3 to 7.0) | 0.12 to 0.55 µs | 5.9 to 6.2 ms (10.5 to 11.1) |
| 1e5 | 3.0 to 4.6 µs (148 to 153) | 1.8 to 2.1 µs (90.7 to 91.7) | 0.28 to 0.84 µs | 56 to 58 ms (159 to 168) |
| 1e6 | **9.5 to 15.1 µs** (1,305 to 1,385, the critic's run) | **6.2 to 7.5 µs** (1,884 to 1,922, the critic's run) | 0.62 to 0.72 µs | 0.69 to 0.80 s (3.40 to 3.59 s, the critic's run) |

**Across partitions and resources** (group B):

| What | Cost |
|---|---|
| the store fed by slot, over a plain lane call | +0.31 to 0.61 µs a record; a record R1 drops 57 ns |
| R2's diff commit, per moved slot | 6.3 to 6.8 µs (1 row), 23 to 32 µs (10), 183 to 222 µs (100), 2.0 to 2.5 ms (1,000): about 2 µs a row |
| eight views at 2,000 rows, per one-record commit | `za(10)` 5.1 to 5.8 µs; the page 1.7 to 2.8; `by().length()` 0.63 to 1.53; `by().sum()` 0.81 to 1.59; the exact `sum` 0.36 to 0.44 (data's coercing `sum` 0.23 to 0.34); `eq` 0.13 to 0.24; `gt` 0.15 to 0.23; all eight 9.7 to 9.9 |
| `by(room).sum(points)`, added per change, 16 buckets | 1.30 to 1.63 µs at 1e4; 1.09 to 1.42 at 1e5; 0.66 to 1.84 at 1e6 (the 1e6 baseline itself moved 2.15 to 3.76 µs) |
| data's `group(fn)` today, same test | 264 to 282 µs at 1e4; 4.1 to 4.9 ms at 1e5; **78 to 94 ms at 1e6** |
| memory per bucket | 118 to 119 B with a count; 399 B with an exact sum |
| `derive`'s view form, a restart at 1e5 source rows and 1e3 buckets | 48.7 to 51.8 ms (the view's build 48.6 to 51.6; the target read 0.04; the difference 0.11 to 0.14 for 59 writes) |
| `lookup` | 2.9 to 3.9 µs a left change; a right change 1.9 to 3.3 µs (1 left row names it), 6.3 to 9.4 (10), 39 to 48 (100); 161 B a left row |
| the exact sum over every finite double, against E-23's | 0.89 to 0.95x on integers; 1.12 to 1.22x on two-decimal floats; 0.88 to 1.04x near the limit (157 to 246 ns an add and remove) |
| a past reader on 1e4 rows | a step 17.9 to 25.6 µs with one view, 16.6 to 32.1 with ten; a seek over about 6,300 differing rows 18 to 28 ms, over all 1e4 rows 34 to 50 ms; open 0.24 to 1.29 µs a record |
| the mark of the record form | 29 B an entry with the write number packed in (the same as today); 93 B as a pair *(checked, E-30's method)* |

## The checks have teeth

Each planted bug ran on the same 1,000 seeds as the real code (bar: at least 100 fail).

| Claim | Planted bug | Seeds failed |
|---|---|---|
| A1 | a plain keyed copy that drops order deltas / a float running sum | 999 / 1,000 |
| A2 | resume from the client's own frame count / the instance check off | 329 / 425 |
| A3 | ties by arrival / a picture before the copy reaches `seen` | 895 / 799 |
| A4 | `allow` only when the entry is built / argument keys not sorted | 163 / 355 |
| A5 | a close inside the linger counted twice / lingering entries not counted | 417 / 645 |
| A6 | dispose before leaving the map / a handler's views not scoped | 159 / 817 |
| A7 | a plain keyed copy / a picture that keeps the old order | 961 / 613 |
| A8 | the entry key without the method version | 765 |
| XA-1 | the leader serves views | 1,000 |
| XA-2 | no headroom / free choice of copy | 925 / 811 |
| XA-3 | instance counters per copy from 1 | 319 |
| XA-4 | a picture replaces the value wholesale | 969 |
| XA-5 | order changes dropped from `c` | 981 |
| XA-6 | `map`/`filter` on a plain keyed data source | 958 |
| XA-7 | one served entry per cursor (deterministic) | 984 of 1,000 page reads refused, from the 17th |
| XA-8 | the impure view itself (a clock per copy) | 822 (control 0) |
| XA-9 | a count-only cap | 363 |
| XA-10 | no version floor | 202 |
| XA-12 | `view-too-big` not remembered | 833 |
| XA-13 | `SYNC` answered before the store passes the write | 934 |
| B1 (G = 4 / elastic) | R2 off / R1 off / ties by arrival | 743, 685, 1,000 / 990, 880, 1,000 |
| B2 | a cursor of the value only / `by` keeps an emptied bucket | 1,000 / 278 |
| B3 | no fence / no removes / the plan as written | 995 / 921 / 796 |
| XB-8, XB-9, XB-10 | no bump / no barrier / no version in the lock row | 898 / 995 / 225 |
| B4, XB-11 | reverse index not moved / count not released / a remove shown as `undefined` | 1,000 / 1,000 / 1,000 |
| B5 (model) | the mark without the write number / the order rule dropped | LOST on all 5 new bounds / LOST on 3 |
| B6, XB-12 | a step record by record / a seek that does not move the views / the whole window under the newest build | 1,000 / 1,000 / 995 |
| XB-1 | a remove that bisects with the new value | 1,000 |
| XB-2 | `za` as the full reverse of `az` / key ties by UTF-8 bytes | 1,000 / 1,000 |
| XB-3, XB-5, XB-6, XB-13 | data's coercing `sum` / `String(v)` bucket keys / ties by row key only / data's arrival `limit` | 1,000 each |
| XB-4 | E-23's exact sum as it is | 992 (and 5 of 8 edge histories) |

Every seeded planted bug failed 159 to 1,000 of 1,000 seeds *(checked)*.

## What the runs changed

Each change is taken into [TRANSFORMS.md](../../TRANSFORMS.md); each part's README gives the evidence.
- **Served views need eight more rules** (group A, seven found by a seeded run failing): a resume answer carries its ring frames; a client routes a frame to every selection on that instance; a frame's position is set before the sink runs; a `get()` that reuses an entry moves no count; a join counts against `views.client`; a client never shows a method below the highest version it has seen; a SUB from a client that held the view may evict lingering entries; an empty aggregate travels as "no value".
- **Headroom covers one failure, not two** (XA-2). **Serve views from standbys** when there are any (A3). **data 5 needs a build that yields**: a resumable key iterator and an ordered index built in slices (XA-1). **A picture may replace a ring resume when it is smaller** (A2). **Bucket and sum views cost a frame encode on every write**, 2 to 5 µs flat (A1).
- **R2 keeps a copy per (slot, importing group)** (B1's first run stopped on it). **`derive`'s view form needs a bump, a read barrier read after the bumps, a silent fold up to the barrier, and the code version in the lock row**; its "may step back once" goes (B3). **XB-8 is restated.** **`lookup` has three states.** **The total order is per direction.** **One numeric projection covers the range filters too** (data's `gt` passes `'60' > 50`). **Typed keys, SameValueZero, (partition, row) at depth 2, `limit` as a window** (XB-5, XB-6, XB-13). **Past views fold each stretch under its own build** (XB-12). **The mark carries the write number, and a record's outputs to one slot go out in order** (B5). **D8c reaches about 10 to 15 µs at 1e6, not a few µs** (XB-1). **data's `package.json` must list its source operator modules as having side effects**, or a bundle of the source drops `group`, the set operators and the quantiles.

## What the simulation leaves out

- **No Raft and no real network.** Logs are in-process lists; an append commits at once; a new leader has every committed entry. Links are in-process queues with seeded delays. E-55 ran the same kind of frames over `MessagePort`s; nothing here re-times the wire.
- **Group A has one group** (as the first build), so positions are log indexes and no slot moves. **Group B's B3 source has one group**; B1 covers the store fed by slot, B3 does not combine the two.
- **Membership is known at once** in group A; real clients learn the copy list late and get `moved`.
- **Time is steps.** Lingers, retries and the wait for `seen` are counted in steps, not timed.
- **Small worlds**: 20 to 50 rows and 3 to 4 clients in group A's sims; 40 to 3,000 keys in group B's. They search orderings; the benches measure sizes.
- **The new operators are prototypes** on data's public API (row sinks, `filter(fn)`, small nodes), so their costs are not data 5's; `by()` pays a sink call and a `Map` per commit that a data operator would not.
- **Two data builds are a stand-in** in B6 (a record kind folded differently by build), not two real data versions.
- **B5 is a bounded model** on E-30's small bounds; its full ablation was started and stopped. **XA-14** (the view selector in E-31's model) was not run. **XA-9's cost classes** are a guess. **XA-11** is a type check, not a run with two resources.
- **One 4-CPU box**, shared with another study; each timed process ran alone under the lock.

## Verdict

**The transformations plan works when built small, once it takes the critic's fixes and eight rules found by building it; three bars miss, and two checks were not run.** Over 1,000 seeds a claim, every served view, class B chain, store fed by slot, new operator, lookup join, derived target and past view equalled its query run from scratch, and every planted bug was caught in 159 to 1,000 seeds *(checked)*. The misses: a served-view build over 1e6 rows stalls its copy 0.2 to 1.9 s (XA-1); failover after two failures refused one held view in 1,000 seeds (XA-2); the chunked leaderboard index costs 9.5 to 15.1 µs a sort-field write at 1e6 rows against a guessed 3 µs (XB-1) *(measured)*. `derive`'s view form as the plan wrote it failed 796 of 1,000 seeds and passed with three fixes. Not run: XA-14's model and B5's full ablation. Every piece ran on data 4's public API in JavaScript: nothing asks for a rewrite of data's engine or for Rust; the answer-changing pieces belong in a breaking data 5.0.0.

E-57: transformations built small on data 63fea66 (group A: served views and pushdown on E-55's prototype, about 2,000 lines; group B: a store fed by slot, the new operators, `derive`'s view form, `lookup`, past views and the record form's mark, about 2,800 lines). Seeded, 1,000 seeds a claim: A1 to A8, XA-3 to XA-13 and B1 to B6, XB-2 to XB-13 pass (B1 19,167,410 checks through 6,122 slot moves; A3 5,371 copy kills and 22,040 pictures; B3 79,209 idle checks and 11,810 deriver changes, with the critic's three fixes; the plan's own B3 design failed 796 of 1,000); XA-1 misses (builds at 1e6 rows stall 0.21 to 1.9 s), XA-2 misses (1 held view refused in 1,000 seeds), XB-1 misses its guessed 3 µs (9.5 to 15.1 µs at 1e6, from 1,305 to 1,385 today); XA-14 not run. Every planted bug fails 159 to 1,000 of 1,000 seeds. Timed, three runs alone under the lock: a served leaderboard 134 to 148 µs a change at 1e5 rows; buckets and sums 1.8 to 4.9 µs; `by().sum()` 0.66 to 1.84 µs at 1e6 against `group(fn)`'s 78 to 94 ms; `lookup` 2.9 to 3.9 µs a left change; a `derive` restart 49 to 52 ms at 1e5 rows; the exact sum over every double 0.88 to 1.22 times E-23's.

## How to rerun

```sh
SP=<a scratch folder holding bin/timing, bin/heavy and dl/esbuild> ./run.sh     # both parts, in full
SP=... ./run.sh a sims          # one step of group A (sims, mutants, timing, types, summary)
SP=... ./run.sh b b3            # one step of group B (sims, timing, model, b1, b1m, b2, b3, b4, b6, xb)
SP=... ./run.sh summary         # both parts' results in short, from the files already there
```

Env: `SP` (required), `NODE` (default `node` on PATH), `RUNS`, `SEEDS`, `DATA` (default `../data` at `63fea66`). Results append to `results/*.jsonl`; move the old files away for a clean rerun.
