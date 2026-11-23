# E-65 X4: live and one-time quantiles over every row, with no process holding every value

**Question.** MERGE.md (section 5.4 item 1) puts a live `median` or `quantile` over every row under a fixed
one-process ceiling: one process must hold every value. The asker already subscribes to every group, so the limit is
the asker's own. X4 asks: **can a median, a p90, a p99 or a rank over every row be kept live, or asked once, while
no process holds every value? Which summaries take updates and removes, how wrong are they, and what does an exact
answer cost?**

## The answer first

- **Yes. A bucket histogram with a relative error, whose counts go down as well as up, does it** (the DDSketch
  idea, with signed counts). Each group keeps counts by bucket; the asker adds them. An update is "old value −1,
  new value +1". The answer at any rank is within a relative error a (1 % here) of the true value, at any row
  count. Through 3 seeded runs of 1,000 seeds (about 10 M commits, 39,720 slot moves, 10,168 group resyncs, the
  value mix skewed, drifting, with duplicates, negatives, zeros, −0, the infinities and non-numbers) every one of
  10.3 M checks after a delivery held the bound, and the count matched exactly *(checked, `sims`)*. Eight planted
  bugs failed 945 to 1,000 seeds of 1,000; the ninth (a one-time read's rank not moved) 822 *(checked)*.
- **Most quantile sketches cannot take a remove; this one can, because its counts are exact.** KLL and t-digest
  are insert-only. KLL with a second sketch for removes (a "turnstile") drifts with churn: its rank error grew from 0.42 % with no updates to 2.2 % at 4 updates a row and 3.3 to 12.7 % at 16. A KLL rebuilt
  from the group's rows once churn passes a share c of the count stayed at 0.19 to 0.90 % rank error, for 1 to 10
  re-inserts a write (c = 1 to 0.1) *(counted, `accuracy`)*. They bound the rank, not the value: at p99.9 of a skewed mix KLL's value was off by up to
  36 to 82 % and t-digest's by up to 1.1 to 20 %, while the histogram stayed under 1 % *(counted)*.
- **An exact live median needs only a thin band of exact values at the asker.** The counts say which bucket holds
  the rank and how many values lie below it; the asker keeps the exact values of the rank's bucket and 2 buckets
  each side. With a = 0.1 % that is about 0.4 % of the rows for a log-normal mix of sigma 1: 39,891 values at 1e7 rows
  *(measured, `band`)*. The exact median equalled the oracle's at 7.8 M checks *(checked)*. When the median walks
  out of the band, the asker asks every group for a picture of a new band (one trip); 77,548 re-bands ran in the
  seeded runs *(checked)*. One write costs the asker 0.56 to 0.81 µs at a = 0.1 % (1e6 to 1e7 rows, every write
  sent), against X1's +0.5 to +1.7 µs a write for a sorted column of every value, which also holds every value
  *(measured)*. A wide band hurts: at a = 1 % and 1e7 rows the band held 399,038 values and a write cost 4.3 to
  4.9 µs, because the band is one sorted array *(measured)*.
- **The live approximate quantile almost frees the asker from the write rate.** A group folds its writes into one
  tick's bucket changes (112 to 250 ns a write on the group); 10,000 writes changed 304 to 334 buckets, and the
  asker added a tick in 58 to 95 µs: **6 to 10 ns a write at the asker** *(measured, `coalesce`)*. R0's fold is
  about 0.28 M writes a second (MERGE.md); this is about 100 times that headroom on the asker's side
  *(arithmetic on measured costs; decode and network not counted)*.
- **A one-time exact quantile takes 1 to 3 trips, not 17 to 39.** Trip 1 gets every group's bucket counts (an asker
  that keeps them live skips it); trip 2 gets the values of one bucket from every group; a third narrows a big
  bucket. At 1e7 rows over 16 groups: 3 trips cold, 2 with live counts, 8,850 to 22,494 values sent, never more
  than one bucket's values at the asker *(measured, `onetime`)*. E-64 O1's selection took 17 to 39 rounds for the
  same two order statistics *(measured there)*. Every rank read in the seeded runs was exact, 172,000 of them,
  37,599 needing a third or fourth trip *(checked)*.
- **A client can merge the sketches itself.** The groups' counts merge by adding; the same coalesced stream (about
  300 changed buckets a tick a group) serves a server or a client *(measured: the asker code is the client code)*.
- **Verdict.** Replace "a live median needs one process" with: **every group keeps signed bucket counts of each
  quantiled field; the asker adds them for a live answer within 1 % (or 0.1 %) at any size; an exact live answer
  adds a band of about 0.4 % of the values; a one-time exact answer is 1 to 3 trips.** It costs 5 to 8 new builder
  rules beyond the merger's, and 0 to 2 user rules, and it removes the ceiling rule for quantiles. Its weak spots:
  the band as one sorted array (needs a chunked index past about 1e5 values), the one-time read needs every group at
  one pinned position (E-64 O1's open U3), and the group pays a bucket lookup on every write of the field.

## Words

- **Group**: one Raft group owning some of the resource's 4,096 slots. **Asker**: the process that wants the
  answer, a server or a client. **Slot move**: a slot's rows leave one group for another.
- **Bucket**: one cell of the histogram. A positive number v is in bucket ceil(log_g v), g = (1 + a) / (1 − a);
  every value in a bucket is within a of the bucket's middle. Negatives mirror the positives; 0 and −0 share a
  bucket; each infinity has its own. Non-numbers and NaN are skipped, as data's `quantile` does.
- **Relative error**: |answer − truth| / |truth|. **Rank error**: how far the answer's rank is from the asked
  rank, as a share of the count. A relative-error summary bounds the first; KLL and t-digest bound the second.
- **Band**: the exact values whose bucket lies in a small range around the asked rank. **Picture**: one group's
  band values at one log position, followed by its changes after that position. **Re-band**: asking every group
  for a picture of a new range.
- **Coalesce**: a group adds a tick's writes into one set of bucket changes, so the asker gets one small message a
  tick, not one a write.
- **Turnstile**: a stream with removes as well as inserts.
- **Oracle**: the true answer, worked out by separate code. **Planted bug**: a switch that breaks one rule on
  purpose, to show the oracle sees it.

## Method

Node 22.22.0 on one 4-vCPU box shared with other studies. No file of fero or `data` is used or changed: the
quantile follows data's definition (`ops/quantile.ts`: numbers only, R type 7, h = (n − 1) q, interpolate between
the order statistics at floor(h) and floor(h) + 1).

- **The summaries** (`src/dd.mjs`, `src/kll.mjs`): the signed bucket histogram (own code, about 60 lines); KLL
  (own code after Liberty's reference; no KLL package was found on npm); with `LIBS`, `@datadog/sketches-js` 2.1.1
  (Apache-2.0; insert only: its `accept` refuses a weight ≤ 0) and `tdigest` 0.1.3 (MIT; insert only). The npm
  DDSketch gave the same answers as the own histogram where both ran *(counted, `accuracy`)*.
- **The live form** (`src/asker.mjs`): per group, the counts and the band; their sums; the band as one sorted array.
- **The one-time read** (`src/onetime.mjs`): counts, then one bucket's values as (value, count) pairs, or, past
  `cap` distinct values in a group, counts of 256 equal parts of the range.
- **The seeded run** (`src/sim.mjs`). One resource of 64 slots (16 in one run) over 2 to 8 groups; 3,000 steps
  (4,000 at 16 slots). Each step one commit (insert, update or remove one row's number; 25 % new rows, 12 % of
  updates remove), a slot move (1 in 250 steps; the slot's values travel as one delivery in each of the two groups'
  queues), or a group resync (1 in 1,000: the asker drops the group's part and takes a picture at its head, first
  taking the other half of every move still queued). Six value mixes, one per seed: log-normal, Pareto, integers 0
  to 100, mixed sign with zeros, ±10^±300, and a log-normal drifting 6 sigma over the run; every mix adds 2 % null,
  1 % NaN, 0.5 % strings, 0.3 % infinities, 0.5 % −0 and 0.7 % negatives. The asker takes 0 to 3 deliveries a step
  from random groups and drains any queue past 100. **The oracle**: the rows of exactly the commits the asker has
  taken, folded on their own by commit order into a sorted array. After every delivery: the counts match; at 9
  quantiles (0 to 1) both order statistics are within a of the oracle's; when every group's band is in, the exact
  median equals the oracle's, and so does a random rank inside the band; the asker's count below the band equals a
  fresh one. Every 250 steps, one-time reads of 4 ranks at the groups' heads, with `cap` 1 to force narrowing.
  **Planted bugs** (`--mutate`), each on the same 1,000 seeds: `nopair` (a move's halves taken one by one),
  `resyncadd` (a resync adds the picture without taking the old part out), `noremove` (the old value is not taken
  out), `bandold` (a value that leaves the band is not taken out of it), `picadd` (a picture does not replace the
  old band), `negbucket` (negatives share the positive buckets), `infbucket` (infinities in a finite bucket),
  `rank7` (h = n q), `nooff` (the one-time read does not move the rank into the narrowed part).
- **Accuracy** (`src/accuracy.mjs`, counted, no timing): five mixes at 1e4, 1e5, 1e6 values, 3 seeds; churn at
  1e5 live values with 0 to 16 updates a row while the mix drifts 3 sigma; band sizes up to 1e7 values.
- **Timing** (`src/bench.mjs`): each cell its own process, alone on the box under the timing lock, three runs;
  inside a run the median of 5 rounds after a warm-up. Load average at process start 1.02 to 1.12 (the one process
  itself). Everything ran inside one process: the groups' work and the asker's in turn, no network. Every process
  ran with at most 3.5 GB of heap; the largest cells (1e7 values) stayed well under it.

## Results

Full tables: [results/summary.md](results/summary.md). Raw lines: `results/*.jsonl`.

### The seeded runs *(checked)*

| code | a | slots | seeds | failed | commits | slot moves | resyncs | checks | exact median checks | re-bands | rank reads (needing 3 or 4 trips) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| real | 1 % | 64 | 1,000 | 0 | 2,985,125 | 11,884 | 2,991 | 3,102,856 | 2,429,844 | 23,947 | 52,000 (14,150) |
| real | 0.1 % | 64 | 1,000 | 0 | 2,985,000 | 11,954 | 3,046 | 3,140,493 | 2,224,860 | 33,624 | 52,000 (1,935) |
| real | 1 % | 16 | 1,000 | 0 | 3,979,987 | 15,882 | 4,131 | 4,056,623 | 3,155,990 | 19,977 | 68,000 (21,514) |

| planted bug | seeds failed of 1,000 | first failure, seed 1 |
|---|---|---|
| `nopair` | 1,000 | count 87 against 86 |
| `resyncadd` | 945 | count 126 against 107 |
| `noremove` | 1,000 | count 41 against 40 |
| `bandold` | 1,000 | an exact rank off by one value |
| `picadd` | 999 | an exact rank off |
| `negbucket` | 1,000 | the minimum 0.69 against −0.70 |
| `infbucket` | 999 | the minimum −1e300 against −Infinity |
| `rank7` | 1,000 | the exact median 1.3141 against 1.3125 |
| `nooff` | 822 | a one-time rank read found nothing; the ±10^±300 mix failed 3 of 167 (its buckets rarely hold two values in one group, so no narrowing happens) |

### Accuracy *(counted; worst of 3 seeds at p50, p90, p99 and p99.9)*

| mix (1e4 to 1e6 values) | histogram, a = 1 %: value error / rank error | KLL k = 200: value / rank | t-digest (npm): value / rank |
|---|---|---|---|
| log-normal, sigma 2 | 0.80 to 0.87 % / 0.09 to 0.17 % | 62 to 82 % / 0.31 to 0.40 % | 1.1 to 20 % / 0.006 to 0.05 % |
| Pareto, shape 1.1 | 0.88 to 0.95 % / 0.06 to 0.58 % | 36 to 79 % / 0.30 to 0.75 % | 11 to 16 % / 0.011 to 0.07 % |
| integers 0 to 100 | 0.97 % / 1.0 % | 1.1 to 2.0 % / 0.12 to 0.46 % | 0.50 to 0.91 % / 0.41 to 0.50 % |
| ±10^±300 | 0.89 to 0.98 % / 0.01 % or less | over 10^6 % / 0.25 to 0.41 % | over 10^14 % / 1.2 to 3.6 % |
| bimodal latency | 0.90 to 0.99 % / 0.65 to 0.75 % | 20 to 26 % / 0.30 to 0.51 % | 0.68 to 2.2 % / 0.011 to 0.04 % |

- **Size.** The histogram used 86 to 842 buckets at a = 1 % for every mix but ±10^±300 (9,651 to 138,057: its
  buckets grow with the log of the value range, not the row count). KLL kept 479 to 612 items; t-digest 103 to
  811 centroids *(counted)*. 16 KLL sketches merged kept the same rank error (0 to 0.43 %) *(counted)*.
- **Under churn** (1e5 live values, the mix drifting 3 sigma): the histogram stayed at 0.83 to 0.98 % value error
  through 16 updates a row. KLL with a removes sketch: 0.42 % rank error at 0 updates, 0.95 % at 1, 2.2 % at 4,
  3.3 to 12.7 % at 16. KLL rebuilt once churn passes c times the count: 0.19 to 0.90 % for 0.94 to 9.94 re-inserts
  a write. KLL that ignores removes: 8.3 to 33 % *(counted)*.

### Band size *(counted; the median's bucket and 2 non-empty buckets each side)*

| mix | a = 1 % | a = 0.1 % | p99's band at a = 0.1 % |
|---|---|---|---|
| log-normal, sigma 2 | 1.96 to 1.99 % of rows | 0.18 to 0.20 % | 0.014 to 0.020 % |
| Pareto, shape 1.1 | 5.5 to 5.6 % | 0.55 to 0.58 % | 0.010 to 0.022 % |
| bimodal latency | 7.5 to 7.6 % | 0.73 to 0.76 % | 0.014 to 0.016 % |
| integers 0 to 100 | 5.0 % (5 distinct values) | 5.0 % (5 distinct values) | 4.0 % |

(1e5, 1e6 and 1e7 rows: the share does not move with the row count.)

### Costs *(measured; three runs alone under the timing lock, median of 5 rounds in each)*

| what | cost |
|---|---|
| one value into or out of a histogram (own, `Map`) | 85 to 104 ns |
| npm DDSketch `accept` (insert only, dense array) | 18 to 20 ns |
| KLL add / npm t-digest push | 198 to 210 ns / 204 to 265 ns |
| merge 16 groups' sketches (62,500 values each): histogram / npm DDSketch / KLL / t-digest | 743 to 837 µs / 338 to 430 µs / 1.31 to 1.60 ms / 4.35 to 4.69 ms |
| merge 64 groups': histogram / KLL / t-digest | 738 to 1,042 µs / 4.9 to 6.6 ms / 15.6 to 24.0 ms |
| a quantile from the summed histogram (434 buckets): first after a change of buckets / again | 75 to 104 µs / 1.7 to 2.7 µs |
| a group folds a write into its tick's bucket changes | 112 to 250 ns |
| the asker adds one tick of 10,000 writes (304 to 334 changed buckets) | 58 to 95 µs, 6 to 10 ns a write |
| live exact, every write sent: a = 0.1 %, 1e6 / 1e7 rows (band 3,918 / 39,891) | 555 to 581 ns / 757 to 808 ns a write |
| live exact, every write sent: a = 1 %, 1e6 / 1e7 rows (band 39,744 / 399,038) | 632 to 737 ns / 4.26 to 4.91 µs a write |
| read the exact median from the band / the approximate one from 441 to 4,374 buckets | 0.32 to 0.50 µs / 2.5 to 34 µs |
| one-time exact median, 1e6 rows, 16 groups: trips, values sent, time | 2 cold (27,622), 1 with live counts (15,880); 36 to 49 ms; gathering and sorting every value 96 to 104 ms |
| one-time exact median, 1e7 rows, 16 / 64 groups | 3 cold, 2 with counts; 8,850 to 83,660 values sent; 0.84 to 1.26 s in one process (every group's scan in turn); gathering and sorting 1.24 to 1.36 s |

Load average at each process start was 1.02 to 1.12, the process itself.

## Verdict

**Pick the signed bucket histogram per group, summed at the asker, for every quantile over every row.**

- Live approximate quantile: within a (1 % or 0.1 %) at any row count, through updates, removes, slot moves and
  resyncs; 6 to 10 ns a write at the asker once groups coalesce a tick; a client can do it too.
- Live exact quantile: the same counts plus a band of about 0.2 to 0.8 % of the values at a = 0.1 % (more for
  data with many equal values, unless the band keeps (value, count) pairs); one re-band trip when the answer jumps.
- One-time exact quantile: 1 to 3 trips, one bucket's values at the asker.
- Not KLL or t-digest: no removes, and their value error at the tails reached tens of percent (t-digest broke on
  ±10^±300). A KLL rebuilt from the rows works but costs 1 to 10 re-inserts a write and bounds only the rank.

This takes the live median and quantiles off MERGE.md's one-process list. It does not help `hold: 'all'`,
`connect()` over everything, or code over every row.

## Limits

- **Scaled down.** The seeded run has 64 slots (not 4,096), 2 to 8 groups and at most about 1,500 live rows, one
  quantiled field, and FIFO queues in place of Raft logs and sockets. Coalescing a tick's bucket changes is timed
  but not in the seeded run; it is the same sum of the same changes *(reasoned)*. The group-side band filter (a
  group sends exact values only for the band, counts otherwise) is not built: the seeded asker filters the values
  itself; the per-group range state it checks is the same one a group-side filter needs *(reasoned)*.
- **No pinned read.** One-time reads ran at the groups' heads with no write between trips. Each trip must see
  every group at one position (E-64 O1's open U3); fewer trips make that window shorter, not gone.
- **One process for timing.** The groups' scans in the one-time read ran one after another in one process; on
  real servers they run side by side, each over its own rows. The scan reads every value of the group each trip; a
  group-side index by bucket would read only one bucket *(reasoned)*.
- **The band is one sorted array.** Its write cost grows with its size (4.3 to 4.9 µs a write at 399,038 values).
  A chunked index (E-64 O1's `OrderIndex2`) or a narrower band is the fix; neither was built.
- **The relative error bounds the value, not the rank.** Where values crowd one bucket the rank can be off by that
  bucket's share (up to 1.0 % here, for integers 0 to 100). Buckets are narrower than 1 only below about
  1 / (2a): 50 at a = 1 %, 500 at a = 0.1 %; there integer answers are exact *(counted, reasoned)*.
- **The band keeps duplicates one by one.** For integers 0 to 100 it held 5 % of the rows at either a; as
  (value, count) pairs it would hold 5 entries, and where a bucket holds one distinct value the counts alone are
  already exact *(counted; the pairs are reasoned, not built)*. Pareto and a bimodal latency mix need 0.55 to
  0.76 % of the rows at a = 0.1 %, against 0.20 % for log-normal *(counted)*.
- **Own code.** The histogram, KLL and the asker are prototypes; the histogram's add costs 85 to 104 ns with a
  `Map`, against 18 to 20 ns for the npm DDSketch's dense array *(measured)*.

## Files

`run.sh` (quick, sims, accuracy, timing, summary, libs), `src/` (dd, kll, asker, onetime, sim, accuracy, bench,
summarize, rng), `results/` (sim.jsonl, accuracy.jsonl, bench.jsonl, summary.md).
