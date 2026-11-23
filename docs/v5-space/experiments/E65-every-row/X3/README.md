# E-65 X3: live code over every row, run per group next to the rows, with a combine step

**Question.** [MERGE.md](../../../MERGE.md) 5.4 item 1 keeps "code over every row" under a fixed one-process ceiling (about 1e6 to 5e6 rows, at most 16,777,216 rows a `data` source, about 0.28 M writes a second). The process that asks (the **asker**) holds every row because the code needs to see every row. Can live code instead run **per group, next to the rows**, and send only small results to be combined, so that no process holds every row? What shape must the code take, which real code fits, where does it run, how do deploys work, and what happens when the author gets the combine wrong?

## The answer first

**Yes, for code that can be written as a fold: a function of one row (`emit`), and a `combine` that merges two results.** That covers counts, sums, averages, histograms, group-by with the author's own keys, distinct values, max and min, a top k by the author's own score, and mergeable sketches. It has no row ceiling: each group's copy works on its own rows only, and the merger holds G small results per bucket.

- **Exact through everything the run threw at it** *(checked)*. Six folds of both kinds, written as an author would, equalled "one process folding every row in key order" after every delivery: 1,000 seeds at 4 groups, 300 at 16, 500 elastic (1 to 16 groups), 1,101 with a rolling deploy of new code, 600 with the mon class's other forms, and two long runs of 20,000 commits over 3,000 keys. Over 1.38 million checks: **0 wrong answers**, through 4,850 paired slot moves of 309,216 slots, 6,894 resyncs, 1,203 merger rebuilds and 1,101 deploys. fero's own checks flagged none of the lawful folds (0 false alarms in 3,502 seeds).
- **fero's side has teeth** *(checked, failing seeds of 300)*: a move's halves taken one by one 172; a resync that adds the picture without taking the old part out 264; a leaving row not rescanned 256; a merger that takes pieces of another code version 300.
- **An author's wrong combine is caught before it serves** *(checked)*. A seeded **self-check** at build, run on each partial's host over pieces of real rows, named the broken law in **300 of 300 seeds for each of nine mistakes**: a non-associative average, a "keep the first" combine, a float sum, a remove that does not undo, a remove on a max, a wrong `keeps` hint, an impure `emit`, a wrong `empty`, and a combine that changes its second argument. The oracle alone saw only 23 of 300 for the wrong hint and 203 for the wrong `empty`: some mistakes stay hidden for long.
- **Floats are the trap a careful author still falls into** *(checked)*. `a + b` on float points is not associative, and `a - b` does not undo it. The self-check flagged it in 300 of 300 seeds; live, 5.6 % of answers were off in their last bits, and in 9 seeds an answer changed when a slot moved with no write at all. Sums must be integers (cents) or fero's exact sum. A related find: `-0 + 0` is `0`, so the check tests pieces folded from `empty()`, as fero only ever holds those.
- **Costs** *(measured; see Costs)*. On a group's copy, per write of its own group: inv folds 0.73 to 4.5 µs; mon folds with a `keeps` hint 5.7 to 19.6 µs (max, top 3), and 28.6 to 96.7 µs for a HyperLogLog, whose rows rarely pass the hint. At the merger, per write: inv folds 0.20 to 1.73 µs, about 0.58 to 5.1 M writes a second on one thread, against about 0.28 M for one process folding every row (MERGE 5.4); folding 16 writes into a frame cuts that 1.2 to 5.7 times. mon folds at the merger grow with the groups: up to 54 µs a write at 256 groups, so they need frames of many writes or a tree over the groups.
- **Rules** *(reasoned)*: builder +8 to +13 on top of MERGE's merger, user +3 to +5 (combine laws, remove undoes, no float `+`, a right `keeps`, small pieces). The first step alone (user `emit`, fero's combines): builder +3 to +5, user +0 to +1.
- **Deploys** *(checked)*. A piece carries its code version; a merger takes only its own. In a rolling deploy the old view stops moving for a group whose last old copy is gone, until every group has a new partial; then the view switches. Exact through 1,101 deploys; the old view stood still for 170.6 steps of a 300-step rollout with one copy a group, 71.2 when old copies overlapped *(checked)*. Retiring old copies only after every group has a new one ends the stall *(reasoned)*.

**Verdict.** For live code over every row, a server-declared fold replaces the row ceiling. The first build should offer it in two steps: **user `emit` with fero's own combines first** (`sum`, `count`, `max`, `min`, `top(k)`, `distinct`: O1's merge classes, exact, nothing new to get wrong), then **user combines** for sketches and custom pieces, guarded by the self-check at build, the audit and the resync check. It does not lift the ceiling for `hold: 'all'`, a whole-resource `f.data.connect()` or an exact live median: those need the rows themselves.

## Words

- **Fold.** The author's code in two parts: `emit(row)` gives (bucket, piece) pairs; `combine(a, b)` merges two pieces of one bucket. `empty()` is the piece of no rows. `remove(a, b)`, if given, takes `b` back out of `a`. `done(piece)` makes the value a client sees.
- **Monoid.** A combine that is associative (`(a+b)+c = a+(b+c)`), commutative (`a+b = b+a`), with `empty()` as identity. Then any grouping of the rows gives the same answer.
- **inv and mon.** The two classes. **inv** has `remove`: a leaving row is taken out in O(1). **mon** has none: a leaving row makes the copy **rescan** that slot's rows for that bucket, next to the rows.
- **keeps.** An optional hint on a mon fold: "taking this piece out cannot change that piece" (for a max: any value below it). It saves the rescan.
- **Partial, merger, cut, slot move, resync.** As in E-64 O1: a partial keeps a fold over one group's rows, on one of its copies; the merger combines the partials' pieces; a cut is one position per group; a slot move's two halves (A's fence, B's open) are taken together; a resync replaces a group's whole part with a new picture.
- **Self-check.** fero's seeded test of the laws at build, over pieces of real rows. **Audit.** Now and then a partial works its pieces out again from its rows and compares. **Resync check.** A picture taken at the merger's place for a group must equal what the merger holds for it.

## What a fold looks like

```ts
// in the server's methods: (clients cannot ship code to servers)
spendByCountry: { fold: {
  version: 3,                                        // bump when the code changes
  emit: (o) => [[o.country, [1, o.cents]]],          // per row: (bucket, piece)
  empty: () => [0, 0],
  combine: (a, b) => [a[0] + b[0], a[1] + b[1]],     // may change a, never b
  remove: (a, b) => [a[0] - b[0], a[1] - b[1]],      // undoes combine (optional)
  done: ([n, c]) => ({ n, avg: c / n / 100 }),
} },
// a client: like any served view
shop.data.spendByCountry(null).on((byCountry) => draw(byCountry))
```

- **A partial per group** runs `emit` on each committed change's row before and after (every copy has both), on one copy that is not the leader, picked by a hash (V5-14 pick 3, per group). **inv**: it sends (bucket, +n, plus, minus). **mon**: it keeps each bucket's piece per slot, per block of 32 slots and per group; a row coming in costs 3 combines; a row leaving rescans its slot's rows of that bucket and folds its block and the group again (up to 32 + slots/32 combines), unless `keeps` says it cannot matter.
- **A merger per fold** on one server picked by a hash, served to clients as a served view (TRANSFORMS 3.8). inv: it adds and removes per bucket. mon: it keeps each group's piece per bucket and combines the G pieces of a touched bucket.
- **Reuse of [E-64 O1](../../E64-past-one-process/O1/README.md).** The world (`src/sim.mjs` is O1's `sim/sim.mjs` with folds in place of its six views), O1's three rules (one cut, a move's halves together, a resync replaces), and its merge shapes: inv is O1's `add` class with user pieces, mon is O1's `extreme` class with user pieces. The row and key helpers are O1's (and so E-57 B's).

## Method

Plain JavaScript on Node 22.22.0, in one process: no network, no Raft, no `data`.

**The folds** (`src/folds.mjs`), over E-23's dirty rows `{ id, points, room }` (numbers, two-decimal values, `null`, strings, `NaN`, the infinities, objects; rooms `'r0'` to `'r49'`, `1` to `5` and `'1'` to `'5'`):
- inv: `roomStats` (count and sum in cents, per room), `hist` (bins of 10), `distinct` (the set of point values, as a multiset);
- mon: `maxByRoom` (with `keeps: x < max`), `top` (the best 3 by a user score, ties by key, with a `keeps`), `hll` (a 64-register HyperLogLog of row keys, with a `keeps`).
- version 2 of each changes it a little (bins of 20, a top 4, and so on), for the deploy.

**The seeded run** (`src/sim.mjs`): O1's world, 1,024 slots, 4, 16 or elastic groups, 400 commits a seed (5 % touch several rows), slot moves of 1, 8 or 64 slots (1 in 250 steps), partial resyncs (4 in 1,000: a new host's picture at the merger's place or past it), outages (1 in 1,000: 20 to 120 steps silent, then a resync), merger rebuilds (1 in 1,000), and with `--deploy` a rolling deploy: each group gets a version-2 partial at a random step over 300 steps and loses its version-1 partial then (`--overlap=0`, one copy a group) or up to 300 steps later. Every frame and picture is copied as it crosses to the merger. **The oracle**: after every delivery, each touched bucket of each fold against one process folding every row of the merger's cut in key order (the author's own functions, from `empty()`); in full every 500 deliveries and after every event. **fero's own checks** are counted apart: the self-check (at step 150, and when a group gains version 2; 200 trials over 64 distinct rows; on the first 4 groups), the audit (every 100 steps, one group), the resync check. **Planted builder bugs** (`--mutate`): `nopair`, `resyncadd`, `norescan`, `mixver`. **An author's mistakes** (`--bug`): nine folds, each run to the end of every seed so each check gets its chance.

**The cost bench** (`src/bench.mjs`), one part per process, each run alone under the timing lock, three runs; in a run the median of 5 rounds after a warm-up:
- `partial`: one group's partial at N = 1e5 and 1e6 rows over G = 4 and 16 groups and 4,096 slots (24 and 244 rows a slot); a write replaces a random row. mon folds in three forms: the default, `nokeeps`, and `flat` (the group's piece folded from every slot again).
- `merger`: G = 4, 16, 64, 256 partials of 2,000 rows make real frames; the merger alone takes 16,384 writes in frames of B = 1, 16 or 256 writes.
- `check`: the self-check's time, and the audit's (pieces from 25,000 and 250,000 rows).

## Results

### 1. Lawful folds stay exact *(checked)*

| World | Seeds | Failed | Flagged by fero | Checks | Paired moves (slots) | Resyncs (at the merger's place) | Rebuilds | Deploys |
|---|---|---|---|---|---|---|---|---|
| 4 groups | 1,000 | 0 | 0 | 397,391 | 1,632 (39,712) | 1,972 (947) | 378 | 0 |
| 16 groups | 300 | 0 | 0 | 117,465 | 492 (11,061) | 626 (343) | 118 | 0 |
| elastic (1 to 16 groups) | 500 | 0 | 0 | 194,641 | 289 (101,192) | 916 (323) | 201 | 0 |
| elastic (1 to 16 groups), rolling deploy, one copy a group | 500 | 0 | 0 | 188,007 | 289 (101,192) | 869 (317) | 125 | 500 |
| 4 groups, rolling deploy, copies overlap up to 300 steps | 300 | 0 | 0 | 111,641 | 499 (11,377) | 556 (274) | 50 | 300 |
| 4 groups, no keeps | 300 | 0 | 0 | 119,120 | 499 (11,377) | 625 (301) | 120 | 0 |
| 4 groups, flat | 300 | 0 | 0 | 119,120 | 499 (11,377) | 625 (301) | 120 | 0 |
| 16 groups, rolling deploy, 20,000 commits over 3,000 keys | 1 | 0 | 0 | 17,060 | 70 (1,421) | 117 (71) | 22 | 1 |
| elastic (1 to 16 groups), 20,000 commits over 3,000 keys | 1 | 0 | 0 | 18,503 | 82 (9,130) | 106 (46) | 19 | 0 |
| 4 groups, rolling deploy, one copy a group | 300 | 0 | 0 | 92,937 | 499 (11,377) | 482 (240) | 50 | 300 |

Every lawful fold kept "one process folding every row in key order" through moves, resyncs, outages, rebuilds and deploys, in every form of the mon class (default, no `keeps`, `flat`). fero's checks raised no false alarm *(checked)*.

### 2. fero's own rules have teeth *(checked, failing seeds of 300 at 4 groups)*

| Planted bug | What it breaks | Failed |
|---|---|---|
| `nopair` | a move's halves taken one by one (O1's rule) | 172 |
| `resyncadd` | a resync adds the picture without taking the old part out (O1's rule) | 264 |
| `norescan` | a leaving row's piece stays in its slot (mon) | 256 |
| `mixver` | the merger takes a piece of another code version | 300 |

### 3. An author's mistakes: who sees them *(checked, seeds of 300 at 4 groups, each run to its end)*

| Mistake | Oracle saw a wrong answer | Answers wrong | Self-check at build (law named) | Audit | Resync check | A move alone changed an answer |
|---|---|---|---|---|---|---|
| average kept as a mean of means | 300 | 87.6 % | 300 (associative) | 300 | 153 | 168 |
| "keep the first" | 300 | 92.3 % | 300 (commutative) | 300 | 138 | 49 |
| float `+` and `-` | 300 | 5.6 % | 300 (remove 213, associative 87) | 258 | 64 | 9 |
| remove forgets the sum | 300 | 71.9 % | 300 (remove) | 300 | 146 | 163 |
| a max with a remove that does nothing | 300 | 24.0 % | 300 (remove) | 300 | 130 | 25 |
| `keeps` true for a value equal to the max | **23** | 0.1 % | 300 (keeps) | 8 | 1 | 0 |
| `emit` reads a module counter | 300 | 67.0 % | 300 (emit not pure) | 300 | 158 | 30 |
| `empty()` is 1, not 0 | **203** | 24.8 % | 300 (identity) | **0** | **0** | 0 |
| combine adds into its second argument | 300 | 79.4 % | 300 (changed second) | **0** | 167 | 8 |

- The self-check named the right law in every seed of every mistake, and never fired on a lawful fold *(checked)*. It is the one check that saw all nine.
- Some mistakes hide from the live answer: a wrong `keeps` hint gave a wrong answer in 23 of 300 seeds (0.1 % of answers), because it needs the max's row to leave while tied. A wrong `empty` hid in 97 seeds. Without the self-check these would ship *(checked)*.
- The audit and the resync check are blind to some (a wrong `empty` is self-consistent; a changed second argument changes the merger's copy, not the partial's). They catch drift that starts later, which the build-time check cannot see *(reasoned)*.
- For an unlawful combine, the answer depends on which rows sit in which group: in up to 168 of 300 seeds an answer changed when a slot moved with no write *(checked)*. That is what a client would see.

### 4. Deploys of new fold code *(checked)*

- **Exact through 1,101 deploys** *(checked)*: the old view kept its old answer, the new one started from every group's new picture, and no answer mixed the two. Taking a piece of another version (`mixver`) failed 300 of 300 seeds.
- **The old view stops moving during a deploy**, for a group whose last old copy is gone, until every group has a new partial. Over a rollout of 300 steps at 4 groups it stood still for **170.6 steps a seed** with one copy a group (the old partial ends when the new one starts) and **71.2** when a group's old copy lasted up to 300 steps longer *(checked, counted)*. With 20,000 commits at 16 groups: 288 of 20,000 steps *(checked)*.
- So the deploy order matters: **give every group a copy with the new code first, then retire the old copies**, and the old view never stops *(reasoned)*. That is an operator's rule, or fero's own when it runs the rollout.
- A fold whose pieces did not change shape could in principle mix versions; fero cannot know that, so it never mixes *(reasoned)*.

### 5. Costs *(measured)*

All on one box shared with other jobs, three runs under the timing lock; ranges are over the runs. Full tables: [results/summary.md](results/summary.md).

**The partial, per write of its own group, on a group's copy** (µs; 4,096 slots, so 24 rows a slot at 1e5 rows and 244 at 1e6):

| Fold | Class | 1e5 rows, 4 groups | 1e6 rows, 4 groups | 1e6 rows, 16 groups | Rows rescanned a write (1e6) |
|---|---|---|---|---|---|
| `roomStats` (count, sum per room) | inv | 1.28 to 1.90 | 2.03 to 2.16 | 1.44 to 1.74 | 0 |
| `hist` | inv | 0.94 to 1.15 | 1.23 to 1.52 | 1.01 to 1.23 | 0 |
| `distinct` (a multiset) | inv | 2.87 to 3.57 | 3.84 to 4.47 | 3.19 to 3.79 | 0 |
| `maxByRoom`, with `keeps` | mon | 10.97 to 13.09 | 8.90 to 10.26 | 5.72 to 7.09 | 0.63 |
| `maxByRoom`, no `keeps` | mon | 12.38 to 13.80 | 21.22 to 23.22 | 10.60 to 12.81 | 2.98 |
| `top` 3, with `keeps` | mon | 15.40 to 19.61 | 13.38 to 15.29 | 9.90 to 11.17 | 2.57 |
| `top` 3, no `keeps` | mon | 65.41 to 70.89 | 302.5 to 342.3 | 224.4 to 254.1 | 177.5 |
| `top` 3, `flat` (every slot folded again) | mon | 664.3 to 791.1 | 817.0 to 906.1 | 116.4 to 133.7 | 2.2 |
| `hll`, with `keeps` | mon | 39.29 to 47.95 | 90.17 to 96.72 | 72.63 to 76.65 | 86.5 |

- inv folds cost what a plain fold of the row costs: 0.73 to 4.5 µs, inside the 18 µs a copy has left for views (TRANSFORMS 8.2) *(measured)*.
- mon folds cost what their rescans cost. With a `keeps` hint that holds for most leaving rows (a max, a top k), 5.7 to 19.6 µs; without it, a top 3 at 1e6 rows rescans 177 rows a write and costs 224 to 342 µs *(measured)*. A HyperLogLog's leaving row is usually the top of its register in its slot, so the hint rarely helps: 29 to 97 µs. Kept as counts per (register, rank) it would be an inv fold, as `distinct` is *(reasoned)*.
- The three levels (slot, block of 32, group) pay: folding every slot again (`flat`) costs 2 to 68 times more *(measured)*.

**The merger, per write of the whole resource** (ns; B writes folded into one partial frame):

| Fold | G = 4, B = 1 | G = 256, B = 1 | G = 256, B = 16 | G = 256, B = 256 |
|---|---|---|---|---|
| `roomStats` | 751 to 883 | 1,442 to 1,729 | 867 to 1,089 | 91 to 120 |
| `hist` | 263 to 346 | 246 to 304 | 88 to 94 | 6.1 to 13.1 |
| `distinct` | 366 to 577 | 862 to 1,423 | 298 to 350 | 110 to 140 |
| `maxByRoom` | 983 to 1,190 | 49,993 to 54,115 | 30,635 to 39,886 | 5,752 to 6,857 |
| `top` 3 | 863 to 981 | 38,318 to 40,516 | 7,092 to 7,883 | 581 to 633 |

- inv folds: one thread takes 0.58 to 5.1 M writes a second at B = 1 and 6.7 to 283 M at B = 256, whatever G is *(measured)*. One process folding every row takes about 0.28 M (MERGE 5.4). The merger is not the limit.
- mon folds: the merger combines every group's piece of a touched bucket again, O(G), so at 256 groups and B = 1 it takes only 18,000 to 26,000 writes a second *(measured)*. Frames of 256 writes bring it to 0.15 to 1.7 M. A tree over the groups would make it log2(256) = 8 combines in place of 256 *(reasoned, not built)*.
- `hll` pieces almost never change once registers fill, so its merger saw no frames at all: its row in the full table says nothing about cost.

**fero's checks** *(measured)*: the self-check takes 0.66 to 15.8 ms per fold at build. The audit, which folds a group's rows from scratch, costs 94 to 2,623 ns a row: 15 to 848 ms for 250,000 rows. That is also what **a one-time fold** costs: 1e7 rows over 16 groups is 625,000 rows a copy, 0.06 to 1.6 s with every copy at once *(arithmetic on measured)*.

The full tables are in [results/summary.md](results/summary.md).

## Verdict

**Take X3 for live code over every row that can be written as a fold, in two steps.**
1. **First build: user `emit`, fero's own combines** (`sum` exact, `count`, `min`, `max`, `top(k)` with ties by key, `distinct`). These are O1's merge classes, already checked; the author writes only a pure function of a row. That covers sums, counts, averages, histograms, group-by with the author's keys, max per key, a top k by the author's score and distinct values, at any number of rows. The self-check still runs on `emit` (purity).
2. **Next: user combines**, for sketches and custom pieces, behind the self-check at build, the audit and the resync check. Prefer inv folds (O(1) everywhere); a mon fold must give a `keeps` hint or pay a rescan per leaving row, and its merger needs frames of many writes or a tree over groups at high G.

It replaces MERGE 5.4 item 1's fixed ceiling **for live code over every row**. The ceiling still applies to `hold: 'all'`, a whole-resource `f.data.connect()` and an exact live median, which need the rows themselves; X1, X2 and X4 cover those.

## What this does not show

- **Real links, Raft, threads, `data`.** Queues stand for links; the partials and the merger are plain code, not `data` 5's views. The partial's row store and its slot index are this prototype's own (GROUPS G7 owes rows by slot).
- **MERGE's rule 4 case.** As in O1, a resync's picture never passes a queued slot move here, so "a picture that passed a queued move carries it" (MERGE 2, rule 4) is still owed, for folds as for O1's views.
- **Deploys with real copies.** A group's copies are modelled as two times (its first new copy, its last old copy); the order in which an operator upgrades servers is not modelled.
- **Only these folds and these mistakes.** Nine mistakes an author could make, each written once. Other wrong combines may pass 200 trials over 64 rows: a law that breaks only on rare values (say, past 2^53) would need those values in the sample *(reasoned)*.
- **Order-dependent sketches** (t-digest and similar) were not built. The table's "no" for them is *(reasoned)*.
- **Speed.** One box shared with other long jobs; JavaScript on Node 22; a prototype's data structures. The mon class's numbers are the prototype's, and where its time goes is named in Costs.
- **Bytes on a wire.** Pieces were copied, never encoded; a piece's size on the wire was not measured.

## Files and how to rerun

- `src/fold.mjs` the fold spelling, the partial (both classes), the merger, the reference fold and the self-check; `src/folds.mjs` the lawful folds and the nine mistakes; `src/lib.mjs` O1's helpers.
- `src/sim.mjs` the seeded run; `src/bench.mjs` the cost bench; `src/summarize.mjs` the tables.
- `results/sim.jsonl`, `results/bench.jsonl` (each line tagged with its run), `results/summary.md`.
- `./run.sh quick` (a smoke run with a pass or fail verdict, nothing written), `./run.sh quick-heavy`, `./run.sh sim`, `./run.sh bench`, `./run.sh summary`, `./run.sh`. `SP` names a folder with `bin/heavy` and `bin/timing` lock wrappers, if there are any.
