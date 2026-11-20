# E-57, group A: served views and pushdown, built small

**Question.** The transformations plan (PLAN 3.1 and 9, with the critic's extra claims XA-1 to XA-14) says how a view the server named in `methods:` (a **served view**, class C) and a plain chain run on a copy (**pushdown**, class B) should work: one shared entry per call, frames with data's order channel, resume from a ring, pictures at or past what the client has seen, failover, caps, linger, redeploys. None of it was built. Built small on data's real engine, does each claim meet its bar? And what does building it show that the plan got wrong or left out?

**It decides** whether PLAN 3.1's served-view entry, as amended by the critic, is the design to build, and which rules and numbers the plan must change.

<!-- answer:start -->
## The answer first

- **The design works, once it has eight rules the plan did not write down** (checked: seeded runs). Over 1,000 seeds per claim, a served view's value equalled the method's query run from scratch, after every frame, in every run on the final code: 0 unequal, 0 back in time, 0 doubled, 0 missed, through 8,600 to 15,500 disconnects and 1,000 to 5,500 copy kills per run with faults, with leader kills, restarts from a snapshot, deploys and rolling deploys. Each check caught the bug planted in it. The eight rules (seven found by a seeded run failing, one added after XA-2's analysis): a resume answer carries its ring frames inside it; a client routes a frame to every selection it holds on that instance; a frame's position is set before the sink runs; a `get()` that reuses an entry moves no count; a join counts against `views.client`; a client never shows a method below the highest version it has seen (XA-10's first run failed 15 of 1,000 seeds without it); a SUB from a client that held the view may evict lingering entries; an empty aggregate travels as "no value" (JSON has no `undefined`).
- **Two bars are missed. First, failover can still refuse a client that held a view** (XA-2: 1 refusal in 1,000 seeds, with headroom). Headroom of `views.max / serving copies` covers one failure. After two failures inside one linger, one copy held 12 live views at a cap of 12 and refused the 13th. A per-copy cap cannot promise this; the plan must say so, or count live views across copies.
- **A leader change is not invisible with three copies** (checked). Served views stay off the leader (0 entries on a leader in every run; the planted bug that lets the leader serve was caught in every seed). But with three voters and no standbys, every new leader was a serving copy, so it handed its views on (`END moved`, then a picture as one commit of differences): 608 to 3,644 hand-offs per 1,000 seeds. Values never went back. Serving only from standbys would make a leader change invisible (reasoned).
- **Second, building a served view over 1e6 rows stalls its copy (XA-1)** *(measured, three runs, each alone under the timing lock)*: 1.5 to 1.9 s for `best(10)` in one block, 0.5 to 0.7 s for the bucket and sum views, and still 0.21 to 0.24 s for those two built in slices, because the only way to list data's keys copies the whole store. At 1e5 rows the sliced builds stall 15 to 16 ms (inside the 50 ms bar) and `best(10)` 94 to 101 ms. `best(10)` cannot be sliced from outside data at all.
- **Costs on today's data** *(measured)*: a served `best(10)` costs its copy 5.7 to 6.2 µs a change at 1e3 rows, 17 to 19 µs at 1e4 and 134 to 148 µs at 1e5, the critic's leaderboard number reproduced; the bucket and sum views stay at 2 to 5 µs; one encode per change is shared by 1,000 subscribers; a served `best(n)` holds 1.1 MB at 1e4 rows and 9.1 MB at 1e5; a join costs about 2 µs plus its picture; a page over one shared index costs 32 B and 10 to 16 µs a read, against 0.7 to 8.3 MB a page when each cursor is its own view. A class B shape costs its copy 1.2 to 3.2 µs a change at 1e3 to 1e4 rows, about what class A costs the client, and saves 105 to 113 B a change on the wire.
- **Pages, purity, deploys, read-your-writes, caps by cost and `view-too-big`** behave as the critic's amended rules say (XA-5 to XA-13): 1,000 page reads build one shared index and are never refused (one entry per cursor is refused from the 17th page); an impure view differs after a failover (its control, a fixed clock, passes); a typed v1 client gets `stale-client`; `SYNC` answers at or past the write (1,965 checks); a cost budget refuses exactly when an independent sum says so; a view past `views.rows` is built at most once per copy.
- **Not run**: XA-14 (the view selector in E-31's model: a separate model-checking job). XA-11 is checked by types only (tsc refuses `lookup` in a `{ view }`), not by a run.

<!-- answer:end -->

## Words used

- **copy**: one server holding a full replica of the resource. Here three copies fold one log, each with its own lag; one of them is the log's **leader**.
- **served view (class C)**: a view a method names with `{ view }`; a client asks for it with one `SUB { method, arg }`. **entry**: the copy's record of one served view: its key, its data view, its subscribers, its ring and its linger.
- **pushdown (class B)**: a plain chain of operators (field tests, sorts with a window, one aggregate) run on the copy over one partition. **class A**: the partition crosses whole and the chain runs on the client.
- **frame**: one commit's changes to one view, encoded once. **picture**: the whole value of a view, sent when a link starts or cannot resume. **ring**: the last K frames of an entry, kept for resumes. **instance**: the id of one entry's life; frames name it.
- **seen**: the highest log position a client has seen. A copy behind it waits before it answers.
- **linger**: how long an entry stays after its last subscriber leaves, so a quick return reuses it.
- **order channel**: data's `at` on an added row and `move` records, so a client keeps an ordered view's order.
- **C1**: the merge contract's rule "ties break by row key". Here every ordered view uses a comparator with ties by row key.
- **planted bug**: a switch (`E57_MUTATE`) that breaks one rule on purpose, to show the check can fail.

## What was built

All code is in this folder. Node 22.22.0, tsc 6.0.2, data at commit 63fea66 imported read only from `../data` (its `api/index.ts`, `kernel/node.ts`, `kernel/scope.ts`), through E-55's prototype (`../../E55-lens-prototype/proto/lens.mjs` for `D` and `SourceNode`). data is imported from its TypeScript source with Node's type stripping, exactly as E-55's prototype does; no bundle is needed (E-55's run.sh uses esbuild only for its import matrix). Nothing in data or E-55 was changed. Versions: [results/versions.txt](results/versions.txt).

| Piece | File | What it does |
|---|---|---|
| the copy | [proto/served.mjs](proto/served.mjs) `Copy` | folds a log commit by commit into data sources (one data commit per log commit); keeps the entries of served views (class C), class B chains and class A partitions; answers `SUB`, `get`, `SYNC`, `call`, `unsub`; one frame text per entry per commit, sent once per link |
| an entry | `Copy.build`, `onViewRecs`, `answer` | key = method, canonical argument (object keys sorted), the method's version; instance = (copy, incarnation, counter); a data scope that owns every data node the view made; ring of K frames; holders and counts; linger; size check against `views.rows` each commit |
| the methods | `table(tv)` | `best(n)` (`az` with a C1 comparator, window n), `after(cursor)` (a page after `[points, key]`), `byTeam` (exact sum per team), `total` (exact sum), `mine(user)` with `allow`, `band({ lo, hi })`, `spread` (buckets that grow), and a handler `countAbove`. Table v2 changes `best` (sorts by `pts`, a new shape) and `byTeam` |
| the new operators | `BucketNode`, `SumNode` | `by(field).sum(f)` and `by(field).length()` with E-23's exact sum (Shewchuk partials), no empty buckets (C5); built outside data as effects on a data node, as PLAN 9 says the prototype must |
| placement | [sim/world.mjs](sim/world.mjs) `owner` | rendezvous hashing of the call's key over the serving copies (alive, not the leader); a SUB at the wrong copy gets `END moved`; when the serving set changes, entries whose owner changed end `moved` |
| caps | `Copy.admit` | `views.max` per copy (lingering entries count), `views.client` per client per copy (joins count), headroom for held views, an optional cost budget (XA-9); an independent count in the world checks every decision |
| pages | `Copy.pageRead` | XA-7: one shared ordered index (`az` with no window); a page read is a bisect for the cursor, then 20 keys; it holds nothing |
| the client | [proto/client.mjs](proto/client.mjs) `Client` | one selection per distinct call (equal calls share it); applies frames with the order channel; applies every picture as one commit of differences; one sink call per frame or picture with `c = { diff, order }`; resumes with `{ instance, seq }` and `seen`; drops frames below its version floor; class A and fallback: a local data source and the chain run here on data's real operators |
| the oracle | [proto/oracle.mjs](proto/oracle.mjs) | pure queries over plain rows, no data: sorts with ties by key, exact sums with BigInt, buckets, scalars, class B chains; ordered answers compared as key sequences |
| the world | [sim/world.mjs](sim/world.mjs) | a seeded log; three copies folding it with their own lags; links with FIFO queues; faults: disconnects, copy kills, leader kills, restarts from a snapshot at a recent position, deploys; every check after every frame, picture, resume answer and SYNC answer, and once more after the run settles |
| the runs | [sim/run.mjs](sim/run.mjs) | one preset per claim; 1,000 seeds; `E57_MUTATE` plants a bug |
| benches | [bench/](bench) | the copy's cost per change per view, resume against picture, build time and event-loop stalls, a join, memory per view and per page, class B against class A |
| types | [types/view.ts](types/view.ts) | XA-11: a `{ view }` context with no second resource and no caller |

## How the claims were measured

- **Seeded runs.** Each claim has a preset in [sim/run.mjs](sim/run.mjs): which calls clients make, how often faults come, the caps. A seed fixes everything; the same seed gives the same line. 1,000 seeds per run, about 300 steps each, three copies, 3 to 4 clients, 20 to 50 rows (a value domain of 10 for `points`, so ties are common). All runs went in one batch under the heavy lock ([batch.sh](batch.sh)); lines in [results/sims.jsonl](results/sims.jsonl).
- **The oracle.** After every frame, picture, resume answer and `SYNC` answer a client applies, its value must equal the query of the method version named in that frame, run from scratch on the truth rows at that frame's position (the serving copy's rows there, since every copy folds the same log). After the run settles, every live selection must equal the query at the end of the log. Back in time: a selection's position must never decrease. Doubled or missed: an add for a key shown, or a change for a key not shown.
- **Planted bugs.** One run of 1,000 seeds per bug, in [results/mutants.jsonl](results/mutants.jsonl). A claim passes only if its oracle catches its planted bug in at least 100 of 1,000 seeds.
- **Timed runs.** Three runs; in each, every process ran alone on the box under the timing lock, preceded by its load average ([batch.sh](batch.sh) `timing`). Inside a process, the ways interleave round by round, a full collection before each round, the median of 5 rounds (3 for builds). Tables show the range over the three runs. Lines in [results/timing.jsonl](results/timing.jsonl); every table is also in [results/summary.md](results/summary.md).

## Results

Marks: *(checked)* = a seeded run or tsc ran it here; *(measured)* = a timed run here, three runs, ranges; *(reasoned)*; *(a guess)*.

| # | Claim | Bar | Result | Verdict | Evidence |
|---|---|---|---|---|---|
| A1 | a served view end to end | 0 unequal in 1,000 seeds for `best(10)`, `byTeam`, `total`, `after(cursor)`; planted bug fails ≥ 100 of 1,000; one encode per view per change with 1 and 1,000 subscribers | 144,843 checks (131,974 frames, 12,869 pictures): 0 unequal, 0 at the end. Planted (a plain keyed copy that drops order deltas): 999 of 1,000 seeds fail. One encode per frame: 277 frames, 277 encodes, 277 sends (1 subscriber); 288 frames, 288 encodes, 288,000 sends (1,000 subscribers) | **pass** | sims `a1`, `share`; mutants `a1 keyedcopy` |
| A2 | resume after a reconnect | 0 doubled, missed, unequal, back in time over ≥ 4,000 disconnects, ≥ 1,000 ring resumes, ≥ 1,000 pictures; each planted bug ≥ 100 | 12,870 disconnects, 6,166 ring resumes, 5,909 pictures after a resume: all 0. Planted (a) resume from the client's own frame count: 329; (b) the instance check off: 425 | **pass** | sims `a2`; mutants `a2 ownseq`, `a2 noinstance` |
| A3 | failover | 0 unequal, 0 back in time, ≥ 1 copy kill per seed; built from a snapshot; each planted bug ≥ 100 | every seed had a kill (5,371 kills, 2,413 of them leader kills); 22,040 pictures; 16,139 builds on copies that came back from a snapshot (no log before it): 0 unequal, 0 back in time. Planted (a) ties by arrival (C1 off): 895; (b) a picture without waiting for `seen`: 799. Killing the leader alone is **not invisible** here: see "The answer first" | **pass**, with the leader finding | sims `a3`; mutants `a3 arrival`, `a3 noseenwait` |
| A4 | sharing, `allow`, no caller | views built = distinct keys for 2,000 subscribers; one encode per change; 0 frames to a subscriber whose `allow` fails; tsc refuses `ctx.claims` | 2,000 subscribers over 25 distinct `band({ lo, hi })` keys written in both key orders: 25 builds, 1,347 joins, 628 shared in-process. Seeded: 3,188 SUBs denied by `allow`, 0 frames to them, 0 duplicate views. tsc: refused (types/view.ts line 51). Planted (a) `allow` only at build: 163; (b) unsorted keys: 355, and 50 builds for 25 keys | **pass** | sims `a4`, `sharing`; mutants; results/types.jsonl |
| A5 | caps and bounds | live + lingering never over a cap; each refusal exactly when an independent count says; 0 frames to a refused SUB; 0 sink calls after `view-too-big`; planted ≥ 100 | 28,211 admissions checked against the independent count: 0 mismatches, 0 over a cap; 4,840 refusals; 1,139 `view-too-big` ends; 0 sink calls after an end or a refusal. Found a real bug first (a `get()` that reused a lingering entry moved its count to the getter, so a client passed `views.client`; 2 of 100 seeds), fixed. Planted: a close inside the linger decrements twice: 417; lingering entries not counted: 645 | **pass** (after the fix) | sims `a5`; mutants `a5 doubledec`, `a5 nolingercount` |
| A6 | linger and dispose order; handler views | 0 rebuilds inside the linger; 0 sink calls after a dispose; 0 live data views at the end | 0 rebuilds inside the linger by construction (a SUB finds the lingering entry in the map), and 3,124 SUBs reused one; 0 sink calls after a dispose (data's own effects checked); after every client closed everything: 0 entries and 0 live data views (data's own graph: children and effects) on every copy; 3,559 handler calls, each a data scope disposed at the end, 0 wrong. Planted: dispose before leaving the map: 159 (its value freezes; the settled check fails); handler views not scoped: 817 (views left) | **pass** | sims `a6`; mutants `a6 disposefirst`, `a6 handlerleak` |
| A7 | class B with the order channel, through resumes and the fallback | 0 unequal over E-55 claim 17's grid; ≥ 1,000 resumes, ≥ 100 fallbacks; each planted ≥ 100 | chains of 1 to 3 plain operators (filters, then `za`/`az` with or without a window, or one aggregate), class B and class A with the chain run here: 79,209 checks, 0 unequal; 5,444 ring resumes, 9,428 pictures after a resume, 4,554 fallbacks to class A past `views.shapes` = 3. Planted (a) a plain keyed copy: 961; (b) a picture that keeps the old order array: 613 | **pass** | sims `a7`; mutants `a7 keyedcopy`, `a7 picorder` |
| A8 | a redeploy | 0 frames from an old-version view after the switch; values after the new SUB equal the new query | 1,000 deploys, 1,365 entries ended `redeployed` (only the methods whose version changed), 0 frames from an old-version entry, 0 unequal. Planted (the key without the version): 765 | **pass** | sims `a8`; mutants `a8 nover` |
| XA-1 | builds never stall long; no leader serves views | event-loop delay ≤ 50 ms (a guess) during builds of `za(10)` and `by().sum()` over 1e6 rows; 0 views on a leader in 1,000 seeds; planted one-block build ≥ 3 s | 0 entries on a leader in every run (checked after every step); planted (the leader serves): 1,000 of 1,000. Stalls *(measured)*: one-block builds at 1e6 rows stall the copy 1,495 to 1,893 ms (`best(10)`), 649 to 741 ms (`byTeam`), 493 to 498 ms (`total`); the bucket and sum builds sliced into 20,000-row slices stall 15 to 16 ms at 1e5 but 211 to 240 ms at 1e6, because listing the keys copies data's store in one block; `best(10)` cannot be sliced from outside data. Planted one-block build: 1.5 to 1.9 s (the bar expected 3 s or more) | **miss** at 1e6 rows (no build stays under 50 ms); the leader part passes | sims (all); timing `rebuild` |
| XA-2 | one copy per view, by hash; failover refuses no holder | builds = distinct keys for 2,000 subscribers over 50 keys on 3 copies; 0 `too-many-views` to holders after a kill | 50 builds for 50 keys, 0 keys on two copies; with a cap of 40 and headroom 20: 40 built, 323 fresh refusals, 0 holders refused after the kill; planted no headroom: 307 holders refused after the kill; planted free choice of copy, with no cap pressure: 100 builds for 50 keys, all 50 on two copies. Seeded (cap 12, headroom 6): **1 holder refused in 1,000 seeds** (two failures in one linger); planted free choice of copy: 811; no headroom: 925 | **miss** (1 of 1,000 seeds) | sims `xa2`, `placement`; mutants |
| XA-3 | a resume names one instance across copies | 0 frames from another instance | instance = (copy, incarnation, counter): 0 in every run. Planted (counters per copy from 1): 319 | **pass** | mutants `a3 copyinst` |
| XA-4 | a new picture is one commit of differences | one sink call; previous + `c.diff` = new; no change entry for an unchanged row | every picture in every run: 0 violations (checked on each picture against the previous value). Planted (wholesale replace with `first`): 969 | **pass** | mutants `a3 wholesale` |
| XA-5 | `c` carries order changes | a list rebuilt from `c` alone equals the key sequence after every frame | 0 unequal in every run. Planted (order changes dropped from `c`): 981 | **pass** (by design: the test shows the channel is needed, not that it is hard) | mutants `a3 noorderc` |
| XA-6 | operators right of a served ordered view keep its order | `map` and `filter` after `best(10)` equal the query's order | 37,076 checks in `a3` (68,296 in `a1`): 0 unequal, on an ordered mirror (rows + order: PLAN's N8, built here outside data). Planted (a plain keyed data source with data's `filter` and `map`): 958 | **pass** | mutants `a3 keyedright` |
| XA-7 | pages share one index; never refused | 1,000 page reads with distinct cursors: ≤ 1 index; heap O(window) per page; 0 `too-many-views` | 1,000 reads, 1 index, 0 refused, 0 unequal; planted (one entry per cursor with a linger): refused from the 17th read on (984 of 1,000). Heap per read: see "Costs" | **pass** | sims `pages`; timing `viewmem` |
| XA-8 | the purity rule is load-bearing | an impure view differs after a failover in ≥ 100 of 1,000 seeds | a `Date.now()`-style threshold (each copy its own clock): 822 of 1,000 seeds differ; control (one fixed clock): 0 of 1,000 | **pass** | mutants `xa8`; sims `xa8ctl` |
| XA-9 | the cap bounds cost | refusals match an independent cost sum exactly | 31,454 admissions, 845 refused, 0 mismatches, never over the budget. Planted (a count-only cap): 363. The costs per class are a guess (µs per write at a nominal 1,000 rows) | **pass** (on a guessed cost model) | sims `xa9`; mutants |
| XA-10 | a rolling deploy never goes back in version; stale typed client refused | 0 pictures of v1 after a client saw v2; v1-typed client gets `stale-client` | 3,000 per-copy deploys with kills: 0 back in version, 2,751 `stale-client`, 1,028 `retry` from copies below the floor, 15 frames dropped by the client floor. First run without the client floor: 15 of 1,000 seeds failed. Planted (no floor): 202 | **pass** (with the client floor) | sims `xa10`; mutants |
| XA-11 | a served view over two resources never goes back, or the types refuse it | tsc refuses `lookup` in a `{ view }` | tsc 6.0.2 exits 0 with three `@ts-expect-error` lines; stripped, each fails: `lookup` (TS2339), `use` (TS2339), `claims` (TS2339). A handler may still join | **pass** (types only; not run) | results/types.jsonl |
| XA-12 | `view-too-big` does not loop | built at most once per deploy; health warns at 80 % | 1,641 `view-too-big` ends, 0 rebuilds of a key after it went too big on that copy; the 80 % warning fired. Planted (no stickiness): 833 | **pass** | sims `xa12`; mutants |
| XA-13 | read-your-writes through `SYNC` | the answer is at or past the write; the value reflects it | 1,965 `SYNC`s: 0 failures. Planted (an answer before the store passes the write): 934 | **pass** | sims `xa13`; mutants |
| XA-14 | the view selector model-checked | E-31's bounds, ablation, ≥ 90 % mutants | not run: it needs E-31's Python model extended with instances, the (instance, seq) resume, the `seen` wait and a terminal `END`; a separate model-checking job | **not run** | — |

## Costs

Three runs; in each, every process ran alone on the box under the timing lock. Ranges over the runs ([results/timing.jsonl](results/timing.jsonl), [results/summary.md](results/summary.md)). Rows `{ id, points, pts, team, name }`, `points` with a value domain of 10. All *(measured)* unless marked.

**A1: what one served view costs its copy per change** (time with the entry minus the same writes without it; it includes data's fold of the change, the view, and the frame's one encode; writes of the field the view reads, one commit each):

| view | 1e3 rows | 1e4 rows | 1e5 rows | bytes per frame | picture bytes (1e3 / 1e5) |
|---|---|---|---|---|---|
| `best(10)` (data's `az`, C1 comparator) | 5.7 to 6.2 µs | 17.4 to 19.1 µs | **134 to 148 µs** | 135 B, on 1.2 % of writes at 1e3, 0.2 % at 1e4 | 884 / 936 |
| `after(cursor)` (a filter that passes about half, then `az`, 20) | 4.2 to 5.1 µs | 4.1 to 5.0 µs | 12.5 to 13.3 µs | 136 B | 1,716 / 1,805 |
| `byTeam` (prototype: exact sum per bucket) | 3.7 to 4.5 µs | 3.7 to 4.0 µs | 4.6 to 4.9 µs | 64.7 to 66.4 B, on every write | 167 / 174 |
| `total` (prototype: exact sum) | 1.8 to 2.6 µs | 2.4 to 2.5 µs | 3.2 to 3.5 µs | 56.1 to 65.2 B, on every write | 87 / 99 |
| (the fold alone, no view: `points` / `pts` writes) | 0.75 to 0.85 / 0.63 to 0.83 µs | 0.94 to 1.0 / 0.90 to 1.0 µs | 1.2 to 1.5 / 1.3 to 1.5 µs | | |

- **A served leaderboard grows with the rows** and reproduces the critic's leaderboard number: 134 to 148 µs a change at 1e5 rows here, 138 to 158 µs there (critic 1.1, uniform values). It is data's sorted-array index, as the critic found. At 1e5 rows one such view is about 7 times PERF-09's whole 20 µs a write *(arithmetic)*. The served-view machinery adds little to it: the frame is encoded only when the top 10 changes, and with many ties that was 0.2 % of writes at 1e4 and none in 1,000 writes at 1e5.
- **The bucket and sum views are flat** in the rows (about 2 to 5 µs a change from 1e3 to 1e5). They are the prototype's nodes outside data, and most of their cost is the frame, encoded on every write because every write changes a sum *(reasoned)*. That is above PLAN 2.2's 0.2 to 1.2 µs for data's counts, which have no frame.
- **One encode per change, shared**: 1 encode per frame with 1 subscriber and with 1,000 (sims `share`: 288 encodes, 288,000 sends) *(checked)*.

**A2: a ring resume against a picture** (1e4 rows, 8 frames missed):

| view | ring answer bytes | picture bytes | copy µs: ring / picture | client decode µs: ring / picture |
|---|---|---|---|---|
| `best(10)` | 1,187 | 921 | 1.4 to 1.7 / 5.8 to 6.2 | 9.0 to 9.5 / 5.9 to 6.8 |
| `byTeam` | 543 | 179 | 1.4 to 1.5 / 2.2 to 2.5 | 4.5 to 4.8 / 1.3 to 1.4 |

- A ring resume is cheaper for the copy (no picture to make) but **not smaller on the wire** for a small bounded view: 8 frames of a 4-bucket view are 3 times its picture. A copy could send whichever is smaller *(reasoned; not built)*. In the sims, ring answers averaged 150 B against 574 B for pictures *(checked: sims `a2`, bytes over count)*.

**A3 and XA-1: building a served view on a copy, and the stall it causes** (the event loop's longest stall during the build; a 1 ms ticker):

| view | build at 1e5 rows | stall, one block, 1e5 | build at 1e6 rows | stall, one block, 1e6 | stall, sliced (20,000 rows a slice), 1e5 / 1e6 |
|---|---|---|---|---|---|
| `best(10)` | 90.2 to 97.1 ms | 94 to 101 ms | **1,440 to 1,521 ms** | **1,495 to 1,893 ms** | cannot be sliced from outside data |
| `byTeam` | 32.1 to 37.6 ms | 32.6 to 45 ms | 643 to 720 ms | 649 to 741 ms | 15 to 16.3 / **211 to 231 ms** |
| `total` | 30 to 34.6 ms | 22.6 to 25.6 ms | 498 to 523 ms | 493 to 498 ms | 14.8 to 16.1 / **222 to 240 ms** |

- **XA-1 misses at 1e6 rows.** Every one-block build stalls the copy for half a second to two seconds. Sliced, the bucket and sum builds stall 211 to 231 ms and 222 to 240 ms at 1e6 (p99 of the ticks 25.8 to 27.1 ms), above the 50 ms bar *(a guess)*, because data has no resumable key iterator: the one way to list the keys, `snapshot()`, copies the whole store in one block *(checked: data kernel/store.ts `snapshot`)*. At 1e5 the sliced builds pass (15 to 16.3 ms). The sliced build is right with commits landing between its slices: 0 wrong buckets after 400 commits *(checked)*.
- The planted one-block `best(10)` build stalls 1,495 to 1,893 ms at 1e6, not the 3 s or more the bar expected from the critic's 3.4 to 3.6 s: these rows have a value domain of 10, and the critic's had a million values *(reasoned)*. It still misses the 50 ms bar 30 times over.
- **The wait for `seen`** is counted, not timed: 943 to 8,894 SUBs per 1,000 seeds waited for their copy to catch up *(checked: sims `waits`)*.

**A4: a join** (one copy of 1e4 rows, 10,000 SUBs joining one `best(10)` entry): 2.0 to 2.1 µs a join (key, lookup, counts, attachment) plus 4.4 to 5.2 µs to encode its picture; 496 B per subscriber.

**A5 and XA-7: memory** (heap after minus before, after a full collection):
- one served `best(n)`: **1,083,503 B at 1e4 rows, 9,061,610 B at 1e5** (about 90 to 110 B a row: data's index of every row, whatever n is). The size check of `views.rows`: 10.4 to 12 ns per entry per commit.
- pages over one shared index: 32 B left per page read and 10.2 to 15.8 µs a read at 1e4 rows, 14 to 16.4 µs at 1e5; the plan as written (one entry per cursor): 719,811 B a page at 1e4 rows, 8,306,778 B at 1e5.

**A7: class B against class A, re-checking E-55 claim 16** (one partition; S shapes of `gt('points', t).za('points', 10)`; in process, no worker):

| | 1e3 rows, 1 shape | 1e3 rows, 10 shapes | 1e4 rows, 1 shape | 1e4 rows, 10 shapes |
|---|---|---|---|---|
| class B: copy µs per shape per change | 1.5 to 2.3 | 1.2 to 1.3 | 2.7 to 3.2 | 2.2 to 3.0 |
| class A: client µs per shape per change | 2.6 to 3.2 | 1.3 to 1.6 | 4.4 to 5.0 | 2.5 to 3.1 |
| bytes per change: class B (all shapes) / class A | 3.1 / 108 | 28 / 108 | 0.10 / 113 | 1.3 / 113 |

- As E-55 found, a shape costs about the same on either side; what pushdown buys is bytes. E-55 measured 3.4 to 5.2 µs per shape at 1e2 to 1e3 rows with 10 shapes and 8 to 12 µs at 1e4, in a worker over a `MessagePort`; here, in one process with the C1 comparator, it is lower and of the same order *(measured; the difference reasoned: no worker, no port)*.

## The checks have teeth

Each planted bug, one run of 1,000 seeds ([results/mutants.jsonl](results/mutants.jsonl)). The bar is at least 100 failing seeds.

| Claim | Planted bug (`E57_MUTATE`) | Seeds failed of 1,000 | What the oracle saw |
|---|---|---|---|
| A1 | `keyedcopy`: the client keeps a plain keyed copy and drops order deltas | **999** | order unequal (52,496 checks) |
| A1 (extra) | `floatsum`: a float running sum in place of the exact sum | **1,000** | bucket and scalar values unequal |
| A2 | `ownseq`: resume from the client's own frame count | **329** | doubled, missed, back in time, unequal |
| A2 | `noinstance`: the instance check off on resume | **425** | frames of a rebuilt view on the old picture |
| A3 | `arrival`: ties by arrival (C1 off), data's `za('points', n)` | **895** | order unequal, at pictures and frames |
| A3 | `noseenwait`: a picture without waiting for `seen` | **799** | 2,106 positions back in time |
| XA-1 | `onleader`: the leader serves views too | **1,000** | entries on the leader |
| XA-3 | `copyinst`: instance counters per copy from 1 | **319** | frames of another instance applied |
| XA-4 | `wholesale`: a picture replaces the value with `first` | **969** | change entries for unchanged rows |
| XA-5 | `noorderc`: order changes dropped from `c` | **981** | a list rebuilt from `c` differs |
| XA-6 | `keyedright`: `map`/`filter` on a plain keyed data source | **958** | right-side order unequal |
| A4 | `allowonce`: `allow` only when the entry is built | **163** | 550 frames to subscribers whose `allow` fails |
| A4 | `unsortedkey`: the key without sorted object keys | **355** | duplicate views; deterministic run: 50 builds for 25 keys |
| A5 | `doubledec`: a close inside the linger decrements twice | **417** | caps exceeded, admissions unlike the count |
| A5 | `nolingercount`: lingering entries not counted | **645** | caps exceeded |
| A6 | `disposefirst`: dispose, then leave the map 4 steps later | **159** | frozen values (settled check), wrong `get()` |
| A6 | `handlerleak`: a handler's views not scoped | **817** | data views left after everything ended |
| A7 | `keyedcopy`: class B frames into a plain keyed copy | **961** | order unequal |
| A7 | `picorder`: a picture keeps the old order array | **613** | order unequal |
| A8 | `nover`: the key without the method version | **765** | 8,215 frames from old-version views |
| XA-2 | `noheadroom` | **925** | admissions unlike the rule; 49 holders refused; deterministic: 307 |
| XA-2 | `freecopy`: a client picks any serving copy | **811** | one key on two copies; deterministic: 100 builds for 50 keys |
| XA-7 | `pageentry`: one served entry per cursor (the plan as written) | deterministic | 984 of 1,000 page reads refused, from the 17th |
| XA-8 | the impure view itself (a clock per copy) | **822** | values differ after failovers; control: 0 |
| XA-9 | `countonly`: a count-only cap | **363** | over the cost budget |
| XA-10 | `tableversion`: no version floor, copy or client | **202** | 1,063 views back in version |
| XA-12 | `nosticky`: `view-too-big` not remembered | **833** | 1,812 rebuilds of a key that was too big |
| XA-13 | `earlysync`: `SYNC` answered before the store passes the write | **934** | 2,890 answers before the write |

Every bug fails at least 159 of 1,000 seeds (bar: 100).

## What building it showed the plan got wrong or left out

Seven of the eight were found by a seeded run failing on the real code, then fixed; the fix is in the code and the claim reran clean. They are rules a builder must write (PLAN 6.3's count should add them):

1. **A resume answer carries its ring frames inside it** (found by A7). With frames sent once per link and routed by instance, the live frames of an instance that another selection of the same client holds arrived before the resume answer and broke the sequence. Sending the ring frames inside the `res` answer, and accepting frames only on a selection that is up, fixed it (proto/served.mjs `answer`; proto/client.mjs `onMsg`, `res`).
2. **A client routes a frame to every selection it holds on that instance** (found by A7). One class A partition fed several chains of one client; routing by instance to one selection lost frames (proto/client.mjs `bind`).
3. **A frame's position is set before the sink runs** (found by A1's first run: every frame checked one commit behind).
4. **A `get()` that reuses an entry moves no count** (found by A5: 2 of 100 seeds let a client pass `views.client`).
5. **A join counts against `views.client`** (found by A5: a client at its cap joined other clients' entries).
6. **A client never shows a method below the highest version it has seen** (found by XA-10: 15 of 1,000 seeds). The copy-side floor (a `SUB` carries `minVer`) is not enough: another selection of the same method, still on a copy not yet upgraded, kept sending v1 frames. The client drops them and subscribes again; that copy answers `retry` until it upgrades.
7. **A SUB from a client that held the view may evict lingering entries** (from XA-2's analysis). It did not remove XA-2's one refusal, which came from live views (below).
8. **An empty aggregate travels as "no value"** (found by A7: `max` of no rows is `undefined`, which JSON turns into `null`). A real codec must keep `undefined` apart from `null`.

And three findings that change the plan's promises:

- **Headroom protects one failure, not two** (XA-2). With `views.max` per copy and headroom `max / serving copies`, two failures inside one linger left one serving copy with 12 live views at a cap of 12; the 13th holder was refused (1 of 1,000 seeds). Either the plan says "a failover may refuse a held view when the cluster is short of copies", or the cap counts live views across all serving copies against what the survivors can hold (reasoned). And headroom halves the usable capacity with two serving copies: in the placement run, a cap of 40 with headroom 20 built 40 of 50 keys and refused 323 fresh SUBs.
- **Serve views from standbys, not from voters** (XA-1, A3). Keeping views off the leader is easy (checked). But with three voters every new leader is a serving copy and must hand its views on: 608 to 3,644 `END moved` per 1,000 seeds. Values never went back and the re-picture is one commit of differences, so a screen does not flicker, but it is a trip and a rebuild. With the plan's default of 3 voters and 2 standbys, views on standbys only would never move on a leader change (reasoned).
- **A served build cannot be sliced from outside data** (XA-1). The bucket and sum views can be built in slices, but data has no resumable key iterator, so the key list is one copy of the store (one block). `best(10)`'s index is built by one sort on its first read. data 5 needs a build that yields: a resumable iterator and an index that can be bulk-loaded in slices (reasoned; see Costs for the stalls).

## What the simulation leaves out

- **Raft.** The log is a list; an append commits at once; a new leader has every committed entry. Copies lag only in applying.
- **Real sockets.** Links are in-process FIFO queues; a disconnect drops what was in flight. E-55 ran the same kind of frames over `MessagePort`s; nothing here re-times the wire.
- **Slots, groups and slot moves.** One group, as in the first build; a position is a log index. Group B tests stores fed by slot.
- **Membership.** Every copy and client sees the copy list and the leader at once; real clients learn them late and get `moved`.
- **Time.** A step is one tick; lingers and retries are counted in steps. The wait for `seen` is counted (`waits`), not timed.
- **Size.** Worlds are small (20 to 50 rows, 3 to 4 clients) so they search orderings, not sizes; the benches measure sizes.
- **The new operators** (`by(...).sum`, `sum`, pages) are built here outside data, so their costs are the prototype's.
- **The cost model of XA-9** is a guess (µs per write by class at a nominal row count).
- **XA-11** is a type sketch, not a run with two resources.

## How to rerun

```sh
SP=<a scratch folder with bin/timing and bin/heavy> ./run.sh types    # XA-11 (tsc 6.0.2)
SP=... ./run.sh sims      # the seeded runs, 1,000 seeds each, one batch under the heavy lock (about 3 minutes of CPU)
SP=... ./run.sh mutants   # the planted bugs (about 4 minutes of CPU)
SP=... ./run.sh timing    # the timed costs, RUNS="1 2 3", each batch under the timing lock
SP=... ./run.sh summary   # results/summary.md
cd sim && E57_SEED=18 node --expose-gc --experimental-strip-types run.mjs a7   # one seed, with the first failure traced
```

Env: `SP` (required), `NODE` (default `node` on PATH), `RUNS`, `SEEDS`, `DATA` (default `../data` at 63fea66). Every process runs with `--max-old-space-size=3000`.

## Verdict

**Served views and pushdown work as PLAN 3.1 and the critic's amendments describe, on data's real engine, once eight more rules are written down; two bars are missed, and one claim was not run.** Over 1,000 seeds a claim, every served view, class B chain and class A fallback equalled its query run from scratch after every frame and at the end, through 8,600 to 15,500 disconnects, up to 5,500 copy kills, leader kills, restarts from a snapshot, deploys and rolling deploys per run, and every planted bug was caught in 159 to 1,000 seeds *(checked)*. The misses: XA-2, where one client that held a view was refused after two failures inside one linger (1 of 1,000 seeds: headroom per copy covers one failure), and XA-1, where building a served view over 1e6 rows stalls its copy 0.2 to 1.9 s (data cannot build an ordered view in slices, and its only key list is a copy of the store) *(measured)*. XA-14 (the view selector in E-31's model) was not run.

**What the plan should change** *(reasoned from the runs)*:
1. Add the eight rules of "What building it showed" to the `served-views` record. Two are new beyond the critic's count (the resume answer carries its frames; a frame goes to every selection on its instance); the rest refine counted rules (caps, version floor, the codec). About +2 to +4 builder rules on the critic's 17.
2. Say that headroom protects one failure; or count live served views across all serving copies against what the survivors can hold.
3. Serve views from standbys when there are any, so a leader change never moves a view; with voters only, a new leader hands its views on (608 to 3,644 hand-offs per 1,000 seeds here).
4. Add to data 5's list, beside D8c: a resumable key iterator, and an ordered index that can be built in slices. Until both land, a served view over a big resource is built off the copy's main thread or not at all.
5. Let a copy send a picture instead of a ring resume when the picture is smaller (true for small bounded views: 179 B against 543 B for 8 missed frames of a 4-bucket view).
6. In 6.2's budget, count one frame encode per write for every bucket or sum view (2 to 5 µs a change here, flat), and keep the critic's finding that a served leaderboard over 1e5 rows (134 to 148 µs a change) does not fit any write budget before D8c.

E-57 group A: built small on data 63fea66 and E-55's prototype (a copy with served-view entries, class B and class A, a client with the order channel and pictures as one commit of differences, a pure oracle, about 2,000 lines). Seeded, 1,000 seeds each: A1 to A8 pass (A1 144,843 checks; A2 12,870 disconnects, 6,166 ring resumes, 5,909 pictures; A3 a kill in every seed, 22,040 pictures; A4 25 views for 2,000 subscribers over 25 keys, 3,188 denials, 0 frames to them; A5 28,211 admissions equal to an independent count; A6 0 live data views at the end; A7 79,209 checks with 4,554 fallbacks; A8 1,365 entries ended `redeployed`, 0 old frames); XA-3 to XA-10, XA-12 and XA-13 pass; XA-11 passes by types; XA-2 misses (1 refusal of a held view); XA-1 misses at 1e6 rows; XA-14 not run. Every planted bug fails 159 to 1,000 of 1,000 seeds. Timed, three runs alone under the lock: a served `best(10)` 5.7 to 6.2, 17 to 19 and 134 to 148 µs a change at 1e3, 1e4 and 1e5 rows; buckets and sums 1.8 to 4.9 µs; one encode per change for 1 or 1,000 subscribers; builds at 1e6 rows stall the copy 0.49 to 1.9 s in one block and 0.21 to 0.24 s sliced; memory 1.1 MB per view at 1e4 rows and 9.1 MB at 1e5; a page read 32 B on one shared index against 0.7 to 8.3 MB per cursor view. Found while building: eight rules (above), seven of them by seeded runs failing; two of those change the plan's promises on caps and versions (a `get()` moving a count, 2 of 100 seeds; a client showing two versions of one method, 15 of 1,000 seeds).
