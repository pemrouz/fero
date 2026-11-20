# E-57 group B: transformations across partitions, resources and time, built small

**Question.** The transformations plan (PLAN, section 9, group B, and the critic's extra claims XB-1 to XB-13) says how views work when they span many partitions and groups, when they feed another resource (`derive`), when they join two resources (`lookup`), and when they look at the past. Does each piece hold when it is built small on data's real engine and attacked by a seeded oracle with planted bugs? What does each cost?

**It decides** the "across partitions and resources" half of the plan: whether one data store fed by slot is enough (no merger), whether `derive`'s view form converges, whether `lookup` keeps its promise, whether views of the past step as one commit, and which of the critic's contract fixes hold. A second builder runs group A (served views) beside this folder.

<!-- answer:start -->
## The answer first

- **Across partitions, one data store fed by slot is enough: no merger** *(measured, seeded)*. Under R0, R1 and R2, eight views over every row (a top 10 with key ties, a page, counts and exact sums per bucket, a count, an exact sum, two filters) equalled the query on the true rows at the store's cut after every entry: 19,167,410 checks over 1e5 commits in each of G = 1, 4, 16 and elastic, 0 mismatches, 6,122 moves of 138,843 slots, 23,498 of them taken while the store was behind (R2's diff commit). Two stores that folded the groups in other orders agreed at every sync point. Each rule is needed: without R2 743 and 990 of 1,000 seeds fail, without R1 685 and 880, with ties by arrival all 1,000. One wording fix: R2 keeps a copy per (slot, importing group).
- **The new operators are exact** *(measured, seeded)*: `by(field, { step })` with a count or an exact sum, `group(field)` with per-row deltas, `eq`/`in` with SameValueZero and typed keys, keyset pages (4,085,362 checks, 0 mismatches; 99,435 page walks joined end to end equal the whole sorted list). Across cuts, every row whose sort value did not change was seen exactly once (984,927 rows). `by().sum()` costs about 1 to 2 µs a change from 1e4 to 1e6 rows in this prototype; data's `group(fn)` costs 78 to 94 ms a change at 1e6 in the same test.
- **`derive`'s view form converges only with the critic's three fixes** *(measured, seeded)*. As the plan wrote it (a fenced write and a full difference on takeover), 796 of 1,000 seeds fail: the target is wrong at idle in 28, stale writes land in 688, old code's output returns in 452. With a bump at every target group, a read barrier taken after the bump, and the code version in the lock row: 0 failures in 1,000 seeds (79,333 idle checks, 11,810 deriver changes, 0 step-backs, 7,475 starts after the source's log was cut). Each fix has teeth (225 to 995 of 1,000 seeds fail without it).
- **The live lookup join works and tells "loading" from "none"** *(measured, seeded)*: 537,670 checks, 0 unequal, links equal to the keys named after every step and 0 after the view ends. It costs 2.9 to 3.9 µs a left change and about 0.4 µs per joined row on a right change.
- **The record form's mark needs the write's number and in-order sending** *(checked: model)*: E-30's model with two outputs of one record in one slot passes all twelve bounds with both rules; without the number, or without the order, an output is lost. Same 29 B a mark when packed. The full ablation was not run.
- **Views of the past step as one commit** and, with both data builds loaded, equal the live fold across a fold-version change *(measured, seeded: 41,000 checks, 0 unequal; 0 extra sink calls)*. The plan's "refuse any window that crosses a change" would have refused 60,000 positions that were answerable.
- **The contract's holes close** *(measured, seeded)*: the total order per direction with UTF-16 ties (XB-2), one numeric projection (XB-3), the exact sum over every finite double at 0.9 to 1.2 times E-23's cost (XB-4: 1,000,000 checks, 0 mismatches), typed bucket keys (XB-5), (partition, row) at depth 2 (XB-6), and `limit` as a window over the order channel (XB-13). Every planted bug failed 992 to 1,000 of 1,000 seeds.
- **One miss: the O(log N) index for a leaderboard (D8c, XB-1)** *(measured)*. It is exact and 86 to 146 times cheaper than today at 1e6 rows, and builds 4 to 5 times faster, but adds 9.5 to 15.1 µs per sort-field write at 1e6 (6.2 to 7.5 in batches), against a guessed bar of 3 µs. The cause is likely memory layout, not the algorithm *(reasoned)*.
- **On data** *(reasoned from these builds)*: every piece here was built on data 4's public API, in JavaScript, as add-ons. Nothing asks for a rewrite of data's engine or for native code; the one cost that misses is a data-structure layout question. But several pieces change answers (the order per direction, the numeric projection for aggregates and range filters, typed bucket keys, the `-0` rule, `limit` as a window, `group`'s per-row deltas), so they belong in a breaking data 5.0.0, as the plan says. Two small data items come out of this part: the `package.json` side-effect list (a bundle of the source drops three operator modules), and a cache-friendly layout for D8c's index.

<!-- answer:end -->

## Words used

- **Slot**: one of a resource's fixed hash buckets; a row's key hashes to one. **Group**: one log (one Raft group in the real design) that owns some slots. **Slot move**: a slot leaves group A for group B in three steps (LAYERS 8.6): B copies the slot while A still takes writes (`import`), A stops taking writes to it (`fence(s, N)`), then B adds the records since the copy and opens the slot (`open(s, N)`).
- **Position of a slot**: how many records of that slot have been folded. A move does not change it (E-19).
- **Store**: one data source that holds a resource's rows in one process. **Cut**: one position per slot; a store's cut is where it has folded each slot to.
- **R0, R1, R2** (PLAN 1.5): R0, a whole-resource store holds every slot (by folding the groups it copies, and by a picture of the others); R1, per slot, a record at or below the store's position is dropped; R2, an importing group's copy is kept apart until `open`, then taken as one commit of differences if the store is behind.
- **View**: a live answer that data keeps up to date from rows. **Oracle**: the same query run from scratch on the true rows, by code that does not use data.
- **Planted bug** (a mutant): a switch that breaks one rule on purpose. An oracle "has teeth" when the planted run fails at least 100 of 1,000 seeds.
- **Deriver**: the process that keeps a target resource equal to a view of a source (`derive`'s view form). **Lock token**: a number that goes up each time a new deriver takes the lock. **Fence**: each target group refuses a write whose token is below the highest it has seen (E-24). **Bump**: a no-op write a new deriver sends to every target group to raise the fence before it acts (XB-8). **Read barrier**: the new deriver folds the source up to the source's commit position, read after the bump, before it writes (XB-9).
- **Step-back**: the target shows an older cut than it showed before.
- **Link**: one subscription this process holds for one key of another resource (for `lookup`). **Picture**: a key's row (or "no such row") when a link starts.
- **Past reader**: a store moved to an older position (E-54). **Fat node**: a per-key list of versions. **Fold version**: the data build that folded a stretch of the log (LAYERS).
- **Typed bucket key** (XB-5): a bucket's name is a type tag plus the value, so `1` and `'1'` are two buckets. **Numeric projection** (XB-3): a value counts in an aggregate only if it is a number and not NaN.

## Method

**What runs.** Everything runs on data's real engine, data 4.0.0 at `63fea66` (read only), bundled once with esbuild into a scratch folder, as E-55's run.sh does (*checked: run.sh*). The contract (PLAN 2.1) and the new operators are built small on data's public API, as E-23 built them: a comparator with the total order and key ties for `az`/`za`, filters as `filter(fn)`, and the exact sum, `by()`, `group(field)`, the O(log N) index and `lookup` as row sinks or small nodes fed by `sink()` (`src/`). So their costs are this prototype's, not data 5's. Slots, groups, slot moves, leaders, failovers, locks and links are simulated in one process by a seeded scheduler, as E-23 and E-55 did. The one Python model (B5) runs on E-16's engine, as E-30 did.

**The oracles.** Each claim has one. After every commit (or every entry a store takes, every step, every idle point, as the claim says) the live answer must equal the same query run from scratch on the true rows, by code in the sim files that does not use data. Ordered answers are compared as key sequences, scalars with `Object.is`, buckets as maps. The true rows come from an independent fold of the records (E-23's `applyTruth`), never from the store under test. Two definitions are shared by a view and its oracle on purpose: the total order (`rowCmp`) and the typed bucket key (`bkey`). Each is checked on its own against a spec written apart (XB-2, XB-5).

**Seeds and planted bugs.** Every run takes a seed; the same seed gives the same run. Each claim's planted bugs are switches (`MUTATE=…`) run on the same seeds as the real code. A claim passes only if the real code has 0 failures and each planted bug fails at least 100 of 1,000 seeds.

**Timing.** Every timed number: three runs, each process alone under the timing lock (`bin/timing`), ranges reported as min to max over the runs. Inside a process a cell is the median of 3 or 5 rounds, the ways interleaved, a full collection before each round. Seeded runs ran under the heavy lock. Every process ran with `--max-old-space-size=3500`. The load average before each timed process is in `results/timing.jsonl`.

**Found while building** (each became part of the design under test, and is listed in "What this part shows the plan should change"):
- A bundle of data's source by esbuild silently drops `ops/setops.ts`, `ops/bucket.ts` and `ops/quantile.ts`: data's `package.json` marks only `dist/ops/*.js` as having side effects, so `group`, the set operators and the quantiles vanish and `median` throws "reserved name ... has no implementation yet" *(checked: grep of the bundle; the fix, `--ignore-annotations`, is in run.sh)*.
- B1's first run stopped on an `open(s, N)` whose kept-apart copy was at a later position: a store that lags can see a slot move twice (A to B, then B to C) before it folds the first. R2's copies must be kept per (slot, importing group), not per slot *(checked: the sim's own assertion)*.
- B3's first full-design run showed step-backs with the read barrier on: the new deriver's catch-up to the barrier sent writes from its lagging store. Folding up to the barrier must be silent; the difference written after it covers those changes *(checked: a trace of the first step-back)*.

## Results

| Claim | Bar (short) | Result | Verdict | Evidence |
|---|---|---|---|---|
| **B1** one store fed by slot | 0 mismatches over 1e5 commits per G = 1, 4, 16, elastic; 1,000+ slot moves, some while 100 behind; planted bugs fail 100+ of 1,000 | 19,167,410 checks, 0 mismatches; 138,843 slots moved (G = 1 has none: one group); 23,498 opens taken behind; planted 685 to 1,000 of 1,000 | **pass** | `results/b1.jsonl`, `results/b1-seeds.jsonl` |
| **B2** new operators | 0 mismatches in 1,000 seeds, value domain 10; page joins equal at 1,000 cuts; `by().sum()` within 1.5x from 1e4 to 1e6; planted 100+ | 0 of 1,000 seeds, 4,085,362 checks; 99,435 joins equal; `by().sum()` 0.66 to 1.84 µs, flat within noise; planted 278 and 1,000 | **pass** | `results/b2.jsonl`, `results/timing.jsonl` |
| **B3** derive's view form | 0 unequal at idle, 3+ deriver changes a seed, 0 stale writes, step-backs only at a change | the plan's design: 796 of 1,000 seeds fail; with the critic's fixes: 0 of 1,000 (0 unequal, 0 step-backs; 1,389 stale writes landed before the bump reached their group, all repaired) | **miss as planned; pass with XB-8, 9, 10**, the stale-write bar restated as XB-8's | `results/b3.jsonl` |
| **B4** lookup | 0 unequal; links = keys named; 0 after the end; planted 100+ | 0 of 1,000; 537,670 checks; planted 1,000 each | **pass** | `results/b4.jsonl` |
| **B5** mark with the write number | every bound passes; ablation finds each rule; planted gives a counterexample | 12 of 12 bounds hold; planted and the dropped order rule each give LOST; full ablation not run | **pass, ablation not run** | `results/b5-model.txt` |
| **B6** past views | 0 unequal in 1,680+ checks; one sink call a step; `old-fold` right | 0 of 1,000; 41,000 checks; 0 extra calls; `old-fold` right at 94,323 positions; planted 995 to 1,000 | **pass** (with XB-12's rule) | `results/b6.jsonl` |
| **XB-1** O(log N) index | at most 3 µs per sort-field write at 1e6, one commit and batches of 256; build at most 3.40 to 3.59 s; exact | 9.5 to 15.1 µs and 6.2 to 7.5 µs; build 0.69 to 0.80 s; exact in 1,000 seeds, planted 1,000 | **miss** (cost at 1e6); pass (build, correctness) | `results/xb.jsonl`, `results/timing.jsonl` |
| **XB-2** total order both ways | no non-number while ten numbers; equal `cmpTotal`, UTF-16 ties | 0 of 1,000; planted 1,000 and 1,000 | **pass** | `results/xb.jsonl` |
| **XB-3** one numeric projection | six aggregates equal one pure query | 0 of 1,000; planted 1,000 | **pass** | `results/xb.jsonl` |
| **XB-4** exact sum, every finite double | 0 mismatches over 1e6 steps; at most 2x E-23's cost | 0 of 1,000,000; 8 of 8 edges; 0.88 to 1.22x; planted 992 | **pass** | `results/xb.jsonl`, `results/timing.jsonl` |
| **XB-5** typed keys, SameValueZero | `by` and `eq` equal the typed rule | 0 of 1,000; planted 1,000 | **pass** | `results/xb.jsonl` |
| **XB-6** depth 2 by (partition, row) | `za(10)` and pages by key path | 0 of 1,000; planted 1,000 | **pass** | `results/xb.jsonl` |
| **XB-7** paging across cuts | each unchanged row seen once; changed ones counted | 984,927 stable rows once each; 80,302 changed; planted 1,000 | **pass** | `results/b2.jsonl` |
| **XB-8** bump at every target group | 0 stale writes accepted after a takeover, empty differences included | 0 after the bump reached a group; 1,389 in the gap before it, all repaired (0 unequal); planted 898 | **pass as restated** (the bar as worded cannot hold) | `results/b3.jsonl` |
| **XB-9** read barrier | 0 step-backs | 0; planted 995 | **pass** | `results/b3.jsonl` |
| **XB-10** code version in the lock | never v1 after v2 through a rolling deploy | 0; planted 225 | **pass** | `results/b3.jsonl` |
| **XB-11** loading against none | `undefined` only before the first picture, `null` after a remove | 0 of 1,000; planted 1,000 | **pass** | `results/b4.jsonl` |
| **XB-12** past views across a fold-version change | equal the live fold with both builds; `old-fold` only for a build that cannot load; seek time at 1e4 and 1e5 changed rows | 0 unequal; `old-fold` right; planted 995; seeks of 6,300 and 10,000 rows 18 to 50 ms | **pass**; the 1e5-row seek not run | `results/b6.jsonl`, `results/timing.jsonl` |
| **XB-13** `limit` as a window | `za(f).limit(n)` = `za(f, n)` | 0 of 1,000 (a `limit` on the order channel); data's `limit` today 1,000 | **pass** for the prototype; data must change | `results/xb.jsonl` |

### B1: one store fed by slot

**Bar.** 0 mismatches over 1e5 commits per configuration (G = 1, 4, 16, elastic), with at least 1,000 slot moves, including moves while the store lags the source group by up to 100 commits; each planted bug fails at least 100 of 1,000 seeds.

**Method.** `sim/b1-store.mjs`. A resource of 1,024 slots over G groups; 3,000 keys, E-23's dirty domain (numbers, two-decimal floats, `null`, missing fields, numeric strings, `'x'`, emoji strings, booleans, objects, `NaN`, `-0`, the infinities). Two consumers, each one `SlotStore` with eight data views: `za('points', 10)` with key ties, a page of 10 after the cursor `[50, 'k1500']`, `by('room').length()`, `by('room').sum('points')` exact, `length()`, `sum('points')` exact, `eq('room', 'r7')`, `gt('points', 50)`. Each consumer takes entries from the groups' logs at about 0.93 an entry a step, in its own interleaving, never more than 100 entries behind a group; about once in 700 steps a resume from up to 50 entries back, once in 900 a picture of a group (R0's state subscribe), once in 1,000 a rebuild of its views. After every entry: every view against the query over the truth at the consumer's cut, the store's touched rows (all rows every 1,000 entries) against that truth, no lane reject, no position going back. Every 2,000 steps both consumers drain to the head and their views are compared with each other.

**Result** *(measured, seeded; `results/b1.jsonl`, `results/b1-seeds.jsonl`)*:

| Groups | Checks | Mismatches | Moves (slots moved) | Opens taken behind (R2's diff commit) | of them 50+ entries behind another group | R1 drops | Failovers (entries again) | Pictures | Rebuilds | Two-store compares |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 2,012,345 | 0 | 0 (a move needs two groups) | 0 | 0 | 7,959 | 267 (6,621) | 193 | 181 | 51, 0 differ |
| 4 | 4,483,775 | 0 | 2,036 (31,354) | 2,472 | 2,440 | 6,982 | 274 (6,660) | 173 | 191 | 51, 0 differ |
| 16 | 4,096,905 | 0 | 2,044 (26,082) | 3,494 | 3,468 | 8,512 | 274 (6,745) | 201 | 179 | 51, 0 differ |
| elastic (up to 16; 762 grows, 748 shrinks) | 8,574,385 | 0 | 2,042 (81,407) | 17,532 | 17,479 | 24,408 | 291 (6,950) | 181 | 174 | 51, 0 differ |

The planted bugs, on 1,000 short seeds (400 commits, 300 keys, the same seeds for every run):

| Groups | Real code | r2: the copy feeds the store before `open` | r1: no drop at or below the position | ties: ties by data's arrival |
|---|---|---|---|---|
| 4 | 0 of 1,000 (19,254,670 checks; 7,958 moves) | 743 | 685 | 1,000 |
| elastic | 0 of 1,000 (40,964,110 checks; 7,919 moves) | 990 | 880 | 1,000 |

**Verdict: pass**, with one caveat: G = 1 cannot have a slot move, so its run covers lag, resumes, pictures and rebuilds only. Every rule is needed: without R2 or R1 the views go wrong in most seeds, and with ties by arrival two stores' top 10 differ.

**Cost** *(measured, three runs under the timing lock; `results/timing.jsonl`)*: the store adds 0.31 to 0.61 µs a record over a plain lane call (R1's compare, the slot's position and the per-slot key sets R2's diff needs); a record R1 drops costs 57 ns. R2's diff commit per moved slot: 6.3 to 6.8 µs with 1 row in the slot, 23 to 32 µs with 10, 183 to 222 µs with 100, 2.0 to 2.5 ms with 1,000 (about 2 µs a row). Per-commit view costs at 2,000 rows, one-record commits, as E-23 run D: `za(10)` 5.1 to 5.8 µs, the page 1.7 to 2.8, `by().length()` 0.63 to 1.53, `by().sum()` 0.81 to 1.59, `length()` 0.01 to 0.23, the exact sum 0.36 to 0.44 (data's own coercing `sum` 0.23 to 0.34), `eq` 0.13 to 0.24, `gt` 0.15 to 0.23, all eight together 9.7 to 9.9 µs. E-23 run D measured its top-k at 2.7 to 3.4 µs at 2,000 rows; this comparator is slower because it handles every value type (C2).

### B2: the new operators

**Bar.** 0 mismatches in 1,000 seeds with a value domain of 10; page joins equal at 1,000 random cuts; `by(field).sum()` per change within 1.5 times from 1e4 to 1e6 rows; each planted bug fails at least 100 of 1,000 seeds.

**Method.** `sim/b2-ops.mjs`. One store of about 120 rows `{ points: 0..9, room, at: 0..999 }` (rooms include `2` and `'2'`; some keys carry an emoji), 300 commits a seed, a tenth of them several rows. Checked after every commit: `by('at', { step: 100 })` with `length()` and with `sum('points')`, `by('room').sum('points')`, `group('room')` (the view, and a mirror rebuilt only from its per-row deltas), `eq('points', 3)`, `in('room', ['r1', 'r3', 2])`, and three keyset pages (`za` and `az`, after fixed cursors). At a random third of the cuts, a walk of pages of 7 over the shared index (`src/index.mjs`), each page the 7 rows after the last page's `[value, key]` cursor, joined end to end, against the whole sorted list. Once a seed the same walk on data's own page views (one `filter(after).az(cmp, 7)` per page, the plan's form).

**Result** *(measured, seeded; `results/b2.jsonl`)*: real code 0 of 1,000 seeds failed: 4,085,362 checks, 0 mismatches; 99,435 page walks at one cut and 1,000 walks on data's page views, all equal to the whole sorted list; 436,280 group deltas, and the mirror built from them equal to the group at every commit. Planted: a cursor of the value only failed 1,000 of 1,000 seeds; `by()` keeping an emptied bucket failed 278 of 1,000.

**Cost** *(measured, three runs under the timing lock)*: added per change with 16 buckets, half the writes moving a row between buckets: `by(room).sum(points)` 1.30 to 1.63 µs at 1e4 rows, 1.09 to 1.42 at 1e5, 0.66 to 1.84 at 1e6; `by(room).length()` 1.31 to 2.04, 0.81 to 1.08, and -0.45 to 2.53 at 1e6. At 1e6 the no-view baseline itself moved between 2.15 and 3.76 µs across the runs, more than the view's own cost, so the 1e6 cells are noise around a small number. data's counts per bucket today (`lengthBuckets(fn)`): 0.25 to 0.42 µs at 1e4, 0.37 to 1.48 at 1e5. data's `group(fn)` today: 264 to 282 µs a change at 1e4, 4.1 to 4.9 ms at 1e5, 78 to 94 ms at 1e6 (E-05 measured 2,574 µs at 1e6 with another write mix; here half the writes move a row, so two buckets of about 62,500 rows are rebuilt). Memory per bucket: 118 to 119 B with a count, 399 B with an exact sum (a `WideSum` each).

**Verdict: pass.** Exact in every check, and `by().sum()`'s own cost does not grow from 1e4 to 1e6 rows (within 1.5 times, inside the noise at 1e6). The prototype's `by()` costs about 1 µs a change more than data's `lengthBuckets(fn)`: a row sink, a `Map` and a flush per commit that a data operator would not pay *(reasoned)*.

### XB-7: paging across cuts

**Method.** In the same runs, walks whose pages are fetched one commit apart (writes in between). A row present at the walk's start whose sort value never changed during the walk must be seen exactly once; rows that changed are counted. **Result** *(measured, seeded)*: 12,468 walks; 984,927 stable rows, each seen exactly once; 80,302 rows changed during a walk (reported, not asserted). Planted (a cursor of the value only): 1,000 of 1,000 seeds failed. **Verdict: pass.** The promise to state: exact within one cut; across fetches, a row is shown exactly once if its sort value did not change between the fetches.

### B3, XB-8, XB-9, XB-10: `derive`'s view form

**Bar.** 0 unequal at idle points in 1,000 seeds with at least three deriver changes each; 0 writes from a stale deriver accepted; never a double count; step-backs only at a deriver change (B3). XB-8: 0 stale writes accepted after a takeover, empty differences included. XB-9: 0 step-backs. XB-10: never v1's output after v2's. Each planted bug fails at least 100 of 1,000 seeds.

**Method.** `sim/b3-derive.mjs`, 600 steps a seed: source commits; derivers paused (8 to 38 steps; the lease is 12) and killed; the source's log cut to its last 20 records now and then; a rolling deploy from v1 (`by('user').sum('cents')`) to v2 (`by('user').length()`) halfway, old code still restarting for a quarter of the run. Two or three deriver processes at a time, each with its own data store and `ByView`. The oracle at every idle point of the holder; the counters as the file's header says.

**Result** *(measured, seeded; `results/b3.jsonl`)*:

| Configuration | Seeds failed | Idle checks | Unequal at idle (seeds) | Stale writes accepted after the takeover (seeds) | Step-backs (at a change / elsewhere) | v1 after v2 (seeds) |
|---|---|---|---|---|---|---|
| **full design**: fence, removes, bump, barrier, version | **0** of 1,000 | 79,333 | 0 | 0 after the bump; 1,389 landed before the bump reached their group (harmless, see below) | 0 / 0 | 0 |
| **the plan as written**: fence, removes | 796 | 91,388 | 209 (28) | 4,890 (688) | 4,610 / 107 | 12,068 (452) |
| planted: no fence | 995 | 46,855 | 8,091 (625) | 140,134 | 3,520 / 1,332 | 69,698 (950) |
| planted: no removes in the restart's difference | 921 | 80,470 | 34,129 (921) | 0 | 0 / 0 | 0 |
| planted: no bump (XB-8) | 898 | 101,071 | 554 (50) | 13,408 (898) | 521 / 485 | 285 (159) |
| planted: no read barrier (XB-9) | 995 | 73,987 | 0 | 0 | 3,687 / 25 | 0 |
| planted: no version in the lock row (XB-10) | 225 | 77,727 | 0 | 0 | 0 / 0 | 4,801 (225) |

In the full design: 11,810 deriver changes (at least 4 in every seed), 395 of them with an empty difference; 4,603 stale writes refused by the fence; 0.748 target writes per source commit. 7,475 of the 11,810 starts came after the source's log had been cut (a rerun of the same seeds with that count added; every other number equal); the deriver read rows only, never history. A double count cannot happen in this form: every write sets a bucket's value, none adds to it, so the idle equality is the check.

**Verdict: B3 as planned: miss** (the plan's own design, fence and removes only, is unequal at idle in 28 seeds, accepts stale writes in 688 and hands the target back to old code in 452). **With the critic's fixes: pass** (B3, XB-9, XB-10), with B3's "0 stale writes accepted" read as XB-8's restated bar below. **XB-8: pass as restated**: 0 stale writes accepted after the new holder's bump reached a group; 1,389 landed in the gap between the lock change and the bump's arrival, which no fence carried by a message can close, and the new holder's difference, read after every bump, repaired each one (0 unequal at idle).

**Cost** *(measured, three runs under the timing lock)*: a restart at 1e5 source rows and 1e3 buckets takes 48.7 to 51.8 ms: the view's build 48.6 to 51.6 ms, the target's read 0.04 ms (in process here: a real read adds a trip), the difference 0.11 to 0.14 ms for 59 writes. In the seeded runs the full design wrote 0.748 target writes per source commit, the plan as written 1.212 (its step-backs and stale writes cost writes too).

### B4, XB-11: a live lookup join

**Bar.** 0 unequal after every commit on either side in 1,000 seeds (left 50 rows, right 1,000 rows, field changes and removes on both sides); links open = distinct keys named after every commit, and 0 after the view ends; `other` is `undefined` only before the key's first picture and `null` after a remove (XB-11); each planted bug fails at least 100 of 1,000 seeds.

**Method.** `sim/b4-lookup.mjs` with `src/lookup.mjs`. Left rows name 120 hot skus, so several left rows share one; right rows change, are removed and come back. A new sku costs one trip: its picture arrives 1 to 4 steps later; then its records arrive 0 to 3 steps late. Links linger 5 steps. The oracle reads the right side's own history at this process's position for each sku.

**Result** *(measured, seeded; `results/b4.jsonl`)*: real code 0 of 1,000 seeds failed: 537,670 checks after every step, 0 unequal, 0 link-count errors, 0 links left after the view ended; 97,836 trips, one per new key (97,477 pictures arrived before their seed ended); 61,011 links ended after their linger; `undefined` seen 1,286,209 times (always while a picture was on its way) and `null` 3,218,860 times. Planted: the reverse index not moved on a field change, 1,000 of 1,000 seeds; a link's count not released, 1,000 of 1,000 (links above distinct keys); a remove reported as `undefined`, 1,000 of 1,000. **Verdict: pass (B4 and XB-11).**

**Cost** *(measured, three runs under the timing lock)*: per left change (its key already held) 2.9 to 3.9 µs; per right change 1.9 to 3.3 µs when one left row names it, 6.3 to 9.4 µs at 10, 39 to 48 µs at 100 (O(k), about 0.4 µs a joined row); 161 B per left row, counting the cached other rows and one link per key (1e4 left rows over 1e3 keys); one trip per new key (the seeded runs: 97,836 trips, one per key first named or named again after its linger).

### B5: the record form's mark with the write's number

**Bar.** E-30's model extended to two outputs per record per output slot passes every bound; the ablation finds each rule needed; the planted bug gives a counterexample.

**Method.** `models/derived2.py`: E-30's model imported unchanged, its outputs widened to (source slot, sequence, B group, w). Two options: `srchi-slot` (today's mark, the source sequence only: the planted bug) and `srchi-slot-w` (the mark is the pair (sequence, w), and a record's outputs to one B slot go out in w order). E-30's seven bounds with w = 0, and five new ones with two outputs of x1 in one slot (`two-short`, `two-gcrash`, `two-drop`, `two-deep`, `two-bmove`: the slot holding both moves while the consumer crashes and restarts).

**Result** *(checked: E-16's engine; `results/b5-model.txt`)*: `srchi-slot-w` holds every property (ONCE, LOST, DONE) on all twelve bounds: E-30's seven (64,897 to 337,773 states, the same counts as E-30's own `srchi-slot` runs) and the five new ones (4,885 to 47,281 states). The planted bug, E-30's `srchi-slot` with its mark of the sequence only, breaks LOST on all five new bounds (a 13-step trace: the second output is answered as a duplicate, never applied, and the cursor passes the record). With the order rule dropped (`--drop emit.inorder`), `srchi-slot-w` breaks LOST too (on `two-short`, `two-deep` and `two-bmove`): the higher output lands first and the lower is taken for a duplicate. So both rules are needed. Bytes per mark *(measured, E-30's method)*: 29 B per entry with the write number packed into the same number (sequence x 256 + w), the same as today; 93 B as a pair. **The full DEV-10 ablation (`--ablate`) was not run**: it was started and stopped so the timed runs could finish; E-30's own ablation of the other `srchi-slot` rules stands. **Verdict: pass, without the full ablation.**

### B6, XB-12: views of the past

**Bar.** `za(5)`, `by().sum()` and a filter on a past reader equal the query over a refold at the reader's position after every step and seek, in at least 1,680 checks; exactly one sink call per view per step; `old-fold` in every crossing case (B6; XB-12 restates it: with both builds loadable, a window across the change equals the live fold; a build that cannot be loaded gives `old-fold`); each planted bug fails at least 100 of 1,000 seeds.

**Method.** `sim/b6-past.mjs`. 120 commits of 1 to 4 records over 40 rows; the fold version changes at commit 60 (the stand-in: `incr` caps at 9 under b1, not under b2). The live copies' rows after every commit are the oracle. A snapshot before the change; per-key versions built in one pass, each stretch under its own build. 40 moves a seed: steps of one commit either way (70 %) and seeks to any position (30 %). After each move: the three views against the query on the live rows there; at most one sink call per view, and one when its value changed. Then, for every position, a reader that holds only b2 must answer `old-fold` exactly where the window needs b1, and a reader with both builds never.

**Result** *(measured, seeded; `results/b6.jsonl`)*: real code 0 of 1,000 seeds failed: 41,000 checks (27,875 steps, 12,125 seeks), 0 unequal, 0 views with more than one sink call in a move, 0 views that changed without one; `old-fold` right at all 94,323 positions checked. Planted: a step applied record by record, 1,000 of 1,000 seeds (58,799 moves where a view got more than one sink call, seeing states inside a commit); a seek that does not move the views, 1,000 of 1,000; the whole window folded under the newest build, 995 of 1,000. Under the plan's K7 rule ("refuse a window that crosses the change"), 60,000 of the positions checked would have been refused; the two-build reader answered every one of them exactly. **Verdict: pass (B6 as XB-12 restates it).**

**Cost** *(measured, three runs under the timing lock)*: a step (one commit either way) on a store of 1e4 rows costs 17.9 to 25.6 µs with one view (`za(5)`) and 16.6 to 32.1 µs with ten (`za(5)`, `by().sum()`, eight filters): data's own `za` over 1e4 rows is most of it (the critic measured 18.2 to 18.5 µs per sort-field write at 1e4). A seek spanning 1e4 records (about 6,300 rows differ) costs 18 to 28 ms and one spanning 1e5 records (all 1e4 rows differ) 34 to 50 ms, with three views: 3 to 5 µs a differing row. To open (load the snapshot, build the per-key versions): 0.98 to 1.29 µs a record over 1e4 records and 0.24 to 0.26 over 1e5. This open feeds whole rows, not data's fold, so it is not comparable with E-55 claim 23's 3.6 to 4.4 µs a record. Not measured: a seek across 1e5 changed rows (the store here held 1e4 rows).

### XB-1: an O(log N) index for a leaderboard (data's D8c)

**Bar.** `za(10)` over every row: at most 3 µs (a guess) added per sort-field write at 1e6 rows, one commit each and in batches of 256 (today 1,305 to 1,385 and 1,884 to 1,922 µs, CRITIC 1.1); the build no slower than today's 3.40 to 3.59 s; the key sequence equals a sort from scratch after every commit; the planted bug fails.

**Method.** `src/index.mjs`: a two-level chunked sorted array (chunks of 512 to 1,024 entries `{ v, k }`, found by a bisect over each chunk's last entry), fed by one row sink on the source, one window reconcile per commit. The oracle (`sim/xb1-index.mjs`): 2,000 rows, values 0 to 999, inserts, removes, sort-field and other-field writes, a fifth of the commits batches of 2 to 256; after every commit the window against a sort from scratch, every 25 commits the whole index. The cost (`bench/xb1-cost.mjs`): the critic's `ordcost.mjs` re-run with the index beside no view and (at 1e4 and 1e5) data's own `za`.

**Result.** Correctness *(measured, seeded; `results/xb.jsonl`)*: 0 of 1,000 seeds failed (200,000 window checks, 8,000 whole-index checks, 39,889 batches); the planted bug (a remove that bisects with the new row) failed 1,000 of 1,000. Cost *(measured, three runs under the timing lock)*: 

| Rows | Added per sort-field write, one commit each: index (data's `za` today) | In batches of 256: index (data's `za`) | Other-field write: index | Build: index (data's `za`) |
|---|---|---|---|---|
| 1e4 | 2.4 to 3.7 µs (19.3 to 20.8) | 1.0 to 1.1 µs (6.3 to 7.0) | 0.12 to 0.55 µs | 5.9 to 6.2 ms (10.5 to 11.1) |
| 1e5 | 3.0 to 4.6 µs (148 to 153) | 1.8 to 2.1 µs (90.7 to 91.7) | 0.28 to 0.84 µs | 56 to 58 ms (159 to 168) |
| 1e6 | **9.5 to 15.1 µs** (1,305 to 1,385, CRITIC 1.1) | **6.2 to 7.5 µs** (1,884 to 1,922, CRITIC 1.1) | 0.62 to 0.72 µs | **0.69 to 0.80 s** (3.40 to 3.59 s) |

Each run's window equalled data's own `za` at the end (`endCheck`). The process peaked near 2.5 GB of heap at 1e6.

**Verdict: miss at 1e6 on the per-write bar; pass on the build and on correctness.** The index is 86 to 146 times cheaper than today per write at 1e6, one commit each, and 250 to 310 times in batches, and its build is 4 to 5 times faster. But 9.5 to 15.1 µs is three to five times the guessed 3 µs. Why *(reasoned, not isolated)*: at 1e6 even the no-view baseline doubles (1.1 to 1.3 µs a write at 1e4, 2.3 to 3.9 at 1e6), so memory, not the algorithm, dominates; each bisect step reads a separate `{ v, k }` object on a 2.5 GB heap, and a remove plus an insert take about 40 such steps. What to try next: each chunk's sort values in a `Float64Array` beside its key array, so a bisect reads contiguous numbers. What the plan should change: D8c stays a precondition for a leaderboard over a big resource (it turns 1.3 ms into about 10 µs), but "a few µs at 1e6" is not shown; 6.2 counts it as about 10 to 15 µs a sort-field write until a layout reaches the bar.

### XB-2, XB-3, XB-5, XB-6, XB-13: the contract's pure oracles

All five run on data's real views (`sim/xb-pure.mjs`), 1,000 seeds of 200 commits each, against specs written apart from `src/lib.mjs` *(measured, seeded; `results/xb.jsonl`)*:

| Claim | What is checked after every commit | Real code | Planted bug: seeds failed of 1,000 | Verdict |
|---|---|---|---|---|
| XB-2 the total order both ways, UTF-16 key ties | `za(s, 10)` and `az(s, 10)` with 3 % strings (one an emoji), booleans, objects, `null`, `NaN` in the sort column and emoji in a third of the keys: no non-number in the window while ten numbers exist; the window equals a spec written as tuples with a hand-written UTF-16 compare; `za`'s numbers equal E-23's `cmpTotal` (copied) | 0 of 1,000; 979,098 checks | `za` as the full reverse of `az` (strings on top): 1,000; key ties by UTF-8 bytes: 1,000 | pass |
| XB-3 one numeric projection | over E-23's dirty domain: `sum`, `avg`, `min`, `max`, `median`, `by(g).sum(p)` each equal one pure query that skips non-numbers (exact sum, `-0` rule) | 0 of 1,000; 1,200,000 checks | data's own `sum` (unary-plus coercion): 1,000 | pass |
| XB-5 typed keys, SameValueZero | `by(v).length()` and `by(v, { step: 10 })` over `1`, `'1'`, `NaN`, `-0`, `0`, `null`, `true`, `'true'`, objects, missing fields, `Infinity` and integers, against an equality written apart (same type, then SameValueZero); `eq(v, x)` for `NaN`, `-0`, `0`, `1`, `'1'`, `null`, `true` | 0 of 1,000; 1,800,000 checks | `String(v)` bucket keys: 1,000 | pass |
| XB-6 depth 2 by (partition, row) | five partitions, row keys `o0` to `o11` repeated in each: `za(s, 10)` and a page after `[5, bob, o3]` compared by key path | 0 of 1,000; 400,000 checks | ties and cursor by the row key only: 1,000 | pass |
| XB-13 `limit` over an ordered parent | a `limit(5)` that reads the parent `za(s)`'s order channel (`wantsOrder`) equals `za(s, 5)` | 0 of 1,000; 200,000 checks | data's `limit` today (arrival order): 1,000 | pass, for a `limit` built on the order channel; data's own `limit` would have to change (F-25) |

Notes: in XB-3, data's `min`, `max` (behind a numbers-only row test) and `median` already follow the projection; only `sum` and `avg` coerce *(measured)*. XB-5's step buckets take finite numbers only; `Infinity` goes to no bucket *(picked here)*.

### XB-4: the exact sum over every finite double

**Bar.** 0 mismatches as values against an exact BigInt-rational oracle over 1e6 random adds and removes, including +-MAX, subnormals and -0; cost per add at most 2 times E-23's away from the limit; the planted bug (E-23's `ExactSum` as is) fails.

**Method.** `sim/xb4-exactsum.mjs`: 1,000 seeds of 1,000 steps over a multiset of up to 48 values (+-MAX, 1.7e308, 1e308, subnormals, the smallest normals, `-0`, `0`, ordinary floats, any exponent, and rarely `NaN` and the infinities), plus the critic's eight edge histories. The oracle turns each double into an integer by doubling (exact) and rounds once through a decimal string (V8's correctly rounded parse) *(from memory: V8 parses decimals correctly rounded)*; it shares no code with `WideSum`.

**Result.** *(measured, seeded; `results/xb.jsonl`)*: 1,000,000 checks, 0 mismatches, 0 of 1,000 seeds failed; the BigInt path was entered 3,002 times and left again when the sum came back down; the critic's eight edge histories all equal (1e308, 1.7e308, Infinity for MAX + MAX, 0 after MAX + MAX - MAX - MAX, -0 for {-0}). The planted bug (E-23's `ExactSum` as is) failed 992 of 1,000 seeds (197,803 checks) and 5 of the 8 edge histories (NaN where the sum is 1e308, 1.7e308, Infinity or 0; +0 for {-0}). Cost *(measured, three runs under the timing lock)*: per add and remove pair, `WideSum` against E-23's `ExactSum`: 0.89 to 0.95 times on integers, 1.12 to 1.22 times on two-decimal floats, 0.88 to 1.04 times near the limit (157 to 246 ns a pair). **Verdict: pass** (bar: at most 2 times).

## What this part shows the plan should change

Each item says what the evidence is. "Rule" means a builder rule in SIMPLICITY's sense.

1. **R2 keeps an importing copy per (slot, importing group), not per slot** (PLAN 1.5). A store that lags can see the same slot move twice before it folds the first move, and a copy keyed by slot alone mixes the two (B1's first run stopped on exactly that, *checked*). No new rule; a sharper wording of R2.
2. **`derive`'s view form needs the critic's three fixes, and the plan as written misses B3's bar** (*measured, seeded*; numbers in B3's row). Without a bump, stale writes land after the takeover and the target is wrong at idle in some seeds; without a code version in the lock row, v1's output returns after v2's. With the bump, the read barrier and the version: 0 unequal, 0 stale writes after the bump, 0 step-backs, 0 v1 after v2. Two details the plan must state: **(a)** the barrier position is read **after** every bump is acknowledged, so no accepted stale write can come from a later cut; **(b)** folding up to the barrier sends no writes: the difference written after it covers them. The user rule "the target may step back once" (PLAN 6.4 rule 4) goes. Rules: +2 to +3 (the bump, the barrier, and the version), as the critic counted.
3. **XB-8's bar cannot hold as worded.** A stale write can still land at a target group between the lock change and the bump's arrival there; no fence raised by a message can stop it. It is harmless because the new holder reads the target only after every bump is acknowledged, so its difference repairs it. The claim to state is: "0 stale writes accepted at a group after the new holder's bump reached it, and the target equals the view at idle".
4. **`lookup` gives three states**, as the critic asked: `undefined` only while a key's first picture is on its way, `null` for "no such row" (after a picture or a remove), else the row (B4, XB-11). One link per distinct key named, counted, ended after a linger and with the view.
5. **The total order is per direction** (XB-2): `za` is numbers descending, then the rest in `az`'s order, then the null group. Ties by key in UTF-16 code units. A `za` that reverses `az` whole puts strings on top.
6. **One numeric projection for every aggregate, and for the range filters too.** data's `sum` and `avg` coerce with unary plus (XB-3's planted bug is data's own `sum`), and data's `gt`/`lt` compare with JavaScript's `>` (so `'60' > 50` passes, *checked: data ops/rowops.ts:279*). B1 and B2 used a `gt` that tests only numbers. The plan should apply the projection (or C2's total order) to `gt`, `gte`, `lt`, `lte` and `between` as well.
7. **`by()` and `eq`/`in` use typed keys and SameValueZero** (XB-5); **at depth 2, ties and cursors use (partition, row)** (XB-6); **`limit` over an ordered parent can be a window** by reading the parent's order channel (XB-13).
8. **Views on a past reader across a fold-version change**: fold each stretch under its own build, and refuse `old-fold` only for a build that cannot be loaded (XB-12, as the critic said). The plan's K7 rule ("refuse a window that crosses a change") would refuse every position past the change in this run (60,000 positions), all of which the two-build reader answered exactly.
9. **The record form's mark carries the write's number, and a record's outputs to one output slot go out in order** (B5). The model shows the second rule is needed too: without it the higher output can land first and the lower one is then taken for a duplicate.
10. **data's `package.json`** should mark its source operator modules as having side effects too (or not rely on side-effect imports), or a bundle of the source drops `group`, the set operators and the quantiles. A small data fix; worth a line in data 5's list.

## What the simulation leaves out

- **No Raft, no network, no threads.** Groups are in-process logs; a "failover" of the store's feed is a resume from an older point (entries delivered again); a "picture" is the group's rows at its head. A leader change inside a group is invisible to a reader of its log, so it is not modelled apart. Links, the lock and the target groups of B3 and B4 are in-process objects with seeded delays.
- **One move at a time per resource**, as LAYERS 8.6 says; a move takes 1 to 64 slots. The move's `abort`/`unfenced` path (LAYERS 8.6 step 6) is not modelled. Slots: 1,024 (E-23's count; LAYERS has 4,096), so each slot holds more rows, which is the harder case for R1 and R2.
- **Positions are one number per slot**; the epoch is left out. A move carries the slot's position, as LAYERS says.
- **Rows carry their own key** (`id`, and `p` at depth 2), because data's comparators see rows, not keys. data 5 would tie by the store's key itself.
- **The new operators are prototypes on data's public API** (row sinks and `filter(fn)`), so their costs are not data 5's. In particular `by()` pays a sink call and a `Map` per commit that a data operator would not.
- **B3's source has one group**, and its deriver folds the source as one store. B1 covers the store fed by slot; B3 does not combine the two.
- **B5 is a bounded model** on E-30's small bounds (two source slots at most, two B groups, two outputs of one record in one slot, one or two restarts, one B slot move). It says nothing beyond them.
- **B6's two data builds are a stand-in**: a record kind (`incr`) whose fold differs by build, not two real data versions (E-43 used two real ones).
- **Timing ran on one 4-CPU box** shared with another study; each timed process ran alone under the lock.

## Files and how to rerun

| File | What it is |
|---|---|
| `src/lib.mjs` | seeded random source, slot hash, canonical printer, the total order (both directions), typed bucket keys, SameValueZero, the numeric projection, `WideSum` (the exact sum over every finite double), E-23's `ExactSum` as the planted bug, an independent fold of records, rows with emoji keys and values |
| `src/ops.mjs` | the contract and the new operators on data's public API: `za`/`az`/`page`, `eq`/`isIn`/`gt`, `SumView`, `ByView` (by with step and one aggregate), `GroupView` (per-row deltas) |
| `src/store.mjs` | `SlotStore`: one data store fed by slot under R0, R1, R2 |
| `src/index.mjs` | `OrderIndex2` (a two-level chunked sorted array, O(log N + chunk) per change) and `WindowIndex` (a leaderboard on it) |
| `src/lookup.mjs` | `Lookup`: the live join with its reverse index, link counts and linger |
| `sim/b1-store.mjs` | B1 |
| `sim/b2-ops.mjs` | B2 and XB-7 |
| `sim/b3-derive.mjs` | B3, XB-8, XB-9, XB-10 |
| `sim/b4-lookup.mjs` | B4, XB-11 |
| `sim/b6-past.mjs` | B6, XB-12 |
| `sim/xb-pure.mjs` | XB-2, XB-3, XB-5, XB-6, XB-13 |
| `sim/xb1-index.mjs`, `sim/xb4-exactsum.mjs` | XB-1's index oracle, XB-4's exact-sum oracle |
| `models/derived2.py` | B5: E-30's model extended (imports E-30's file, does not change it) |
| `bench/xb1-cost.mjs`, `bench/b1-cost.mjs`, `bench/costs.mjs`, `bench/b5-mark.mjs` | the timed costs and the mark's memory |
| `run.sh`, `summarize.mjs` | everything from a clean checkout; the result lines in short |
| `results/*.jsonl`, `results/b5-*.txt`, `results/versions.txt` | raw results |

To rerun: `SP=<a scratch folder holding bin/timing, bin/heavy and dl/esbuild> ./run.sh` (everything), or `./run.sh sims`, `./run.sh timing`, `./run.sh model`, or one part (`b1`, `b1m`, `b2`, `b3`, `b4`, `b6`, `xb`). `node summarize.mjs` prints the results in short. Node 22.22.0, data at `63fea66`, esbuild 0.25.12, Python 3.13.
