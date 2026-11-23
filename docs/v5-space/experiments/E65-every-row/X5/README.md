# E-65 X5: the wildcard. Other ways past a fixed row ceiling

**The question, in our words.** MERGE.md (5.4 item 1) proposed a fixed one-process ceiling for the features the merger cannot split: `hold: 'all'`, a whole-resource `f.data.connect()`, code over every row, and a live median. X1 to X4 tried four roads past it (the asker holds more; a scan; user code per group; quantile summaries). X5 looks for roads outside those four, judges each, and builds the two that looked most promising: a **slot sample** and **clients that merge** the groups' partials themselves.

**Marks.** *(measured)*: timed, three runs, each alone on the box under the timing lock, a range. *(checked)*: a seeded run with an oracle and planted bugs. *(counted)*: a count from a run. *(reasoned)*: an argument nothing ran. *(from memory)*: an outside fact not checked here.

**Words.** **Asker**: the process that wants every row. **Slot**: one of 4,096 hash buckets; a partition's key picks its slot. **Group**: a Raft group owning some slots. **Partial**: a view over one group's rows (MERGE 2). **Interval**: a range that should hold the true answer 95 times in 100.

## The answer

1. **No variation keeps a sync read of every row past one process.** Rows fetched when touched, the hot set, a hybrid hold, a shared holder on the box and the asker split over its own processes all turn a sync read of a missing row into a trip, which V5-16 refused. For `hold: 'all'` and a whole-resource `connect()`, X1's memory budget stays the answer *(reasoned)*.
2. **A slot sample has no row ceiling for estimates.** The asker holds k of the 4,096 slots, picked by a salted hash, and scales up: totals by 4,096 / k, intervals from the spread of the slot totals. Memory, fold work and bytes sent shrink to k/4,096 (6.1 to 6.4 % of writes sent at k = 256) *(counted)*. It answers live counts, sums, means, shares, quantiles and any per-partition test, with no `combine` to write.
3. **It stayed honest:** real code failed 0 of 100 seeds; intervals held the truth 92.5 to 94.8 % of the time; each of six planted bugs failed 100 of 100 seeds *(checked)*. With heavy tails, 85.8 to 93.6 % (89.5 to 95.3 % at k = 1,024) *(checked)*.
4. **It is cheap:** the copy drops other slots' records for 1.5 to 1.9 ns each; one read of every estimate, a median with its interval included, takes 0.61 to 0.84 ms *(measured)*. At k = 256 the intervals were about ±4 to ±12 % *(checked)*.
5. **It cannot do** min, max, top k or distinct counts of a field: the sample's max was 0.12 to 0.91 of the true one, and a scaled distinct count overshot 1.6 to 19 times *(checked)*. A time window is not a sample: its interval for the mean held the truth 16 % of the time *(checked)*.
6. **Clients that merge lose to a merger with relays.** For a random top 10, a client takes 14 to 20 times more frames at 16 groups and 217 to 318 times at 256, over one link a group, and the busiest sender does not shrink *(counted)*. Only for sums and rising scores does it spread the busiest sender, which relays also do *(counted)*.
7. **For exact live work, a sized holder** (one designated process holding every row once for many askers) moves the ceiling from every asker to one process the deployment sizes *(reasoned)*.

## What was built

About 530 lines of plain JavaScript, Node 22.22.0, no dependencies; `data` is not needed.

- `src/sample.mjs`: the slot sample. A world of uneven partitions (rows in one partition alike, busy partitions spending a little more), 20,000 writes (updates, inserts, deletes), and 20 independent picks of k slots folding the same writes. Two checks a seed: **exact** (held rows equal the oracle's rows in those slots) and **cover** (each of six estimates' intervals holds the truth in at least 14 of 20 picks). Planted bugs: `noscale`, `skipempty`, `rowvar`, `hotpick`, `window`, `lostdelete`.
- `src/sample-bench.mjs`: timing of the copy's slot filter, the asker's per-slot bookkeeping per write, and one full read.
- `src/clientmerge.mjs`: counts partial and merged frames for a top 10 (random and rising scores) and sums per bucket, derives the sends of a merger, a merger with relays and client merging, and checks a merging client against the oracle. Planted bug: `answeronly`.
- `src/cm-bench.mjs`: timing of a client's merge per partial frame.
- `src/summarize.mjs`: `results/summary.md`.

## Results

### Slot sample: honest? *(checked)*

| World | Seeds | Failed | Interval held the truth (count, sum, mean, paid share, median, p90) |
|---|---|---|---|
| moderate, k = 256, about 11 partitions a slot | 100 | 0 | 94.5, 93.4, 92.9, 94.4, 94.8, 92.5 % |
| moderate, k = 256, under 1 partition a slot | 100 | 1 | 92.1, 91.2, 91.6, 93.7, 93.7, 92.1 % |
| moderate, k = 64 | 50 | 0 | 92.6 to 93.4 % |
| heavy tails, k = 256 | 100 | 6 | 92.9, 85.8, 86.5, 92.7, 93.6, 88.0 % |
| heavy tails, k = 1,024 | 50 | 1 | 94.3, 90.2, 89.5, 94.0, 95.3, 90.3 % |

| Planted bug | Seeds failed | What broke |
|---|---|---|
| `noscale` (totals not scaled up) | 100 of 100 | count and sum held 0 % |
| `skipempty` (empty sampled slots left out; sparse world) | 100 of 100 | count 0 %, sum 0.5 % |
| `rowvar` (interval from rows, not slots) | 100 of 100 | intervals held 53 to 72 % |
| `hotpick` (the k fullest slots) | 100 of 100 | count and sum held 0 % |
| `window` (only rows written lately) | 100 of 100 | mean held 16 %, median 19 % |
| `lostdelete` (a delete in a held slot dropped) | 100 of 100 | the exact check |

Interval half-widths at k = 256, moderate world: count 5.6 to 9.2 %, sum 6.9 to 11.9 %, mean 3.7 to 6.9 %, median 4.0 to 6.6 %, p90 5.0 to 9.8 %. Four times the slots about halved them *(checked)*. Every row of the tables is in `results/summary.md`.

### Slot sample: cost *(measured, three runs)*

| Cell | Range |
|---|---|
| copy drops a record of a slot not held | 1.53 to 1.85 ns |
| asker's per-slot bookkeeping per sampled write, 62,500 / 625,000 rows held | 278 to 341 ns / 1.22 to 1.53 µs |
| one read of every estimate with intervals, 62,500 / 625,000 rows held | 608 to 638 µs / 715 to 838 µs |

At k = 256 the asker holds and folds 1/16 of a resource: on X1's 298 B a row and 0.27 to 0.30 M records a second, about 1.9 GB for 1e8 rows and 4.3 to 4.8 M writes a second resource-wide *(arithmetic on X1)*.

### Clients that merge *(counted, checked; merge measured)*

| View | Partial frames a write | Merged frames a write | A merging client takes |
|---|---|---|---|
| top 10, random, G = 16 | 0.0032 to 0.0035 | 0.00016 to 0.00023 | 14 to 20 times more, over 16 links |
| top 10, random, G = 256 | 0.050 to 0.051 | 0.00016 to 0.00023 | 217 to 318 times more, over 256 links |
| top 10 rising, or sums | about 1 | about 1 | the same, over G links |

Busiest sender, sends a write, G = 16, 10,000 clients: random top 10: merger 2.3, merger with a relay a 1,000 clients 0.23, clients merging 3.1. Sums: 10,000, 1,000 and 625; relays of 100 clients each give 100. A merging client: 0 of 14 seeds wrong (10 at G = 16, 4 at G = 256); the `answeronly` client failed 5 of 5 random-score seeds and 0 of 5 rising ones, where no row leaves the top. Merge cost per partial frame: 0.66 to 0.71 µs at G = 16, 7.0 to 7.3 µs at G = 256 *(measured)*.

## Verdict

- **Keep the slot sample as a candidate feature**: estimates over every row, live or once, at any row count, for +4 to +7 builder rules and +1 to +2 user rules *(reasoned)*. It beats X3 when the code has no combine, X1 past the memory budget, and X2 on time for a one-time estimate; it loses to X4 for quantiles and never replaces exact answers.
- **Drop client merging**: relays do its one good part with one link a client.
- **A sized holder** is the only wildcard for exact live work over every row; it is a deployment shape more than a new mechanism.
- **Nothing beats X1's budget for sync every-row reads.**

## Limits

- The sample's probe has no groups, slot moves, failures or network; moves would reuse E-57 B1's store-by-slot rules, not run here.
- The worlds are made up; data with heavier tails would hold its intervals less often. Only the simple normal-curve interval was tried.
- Timed parts are plain-JavaScript stand-ins, not `data`; the held row's own fold is X1's cost.
- Client merging is a count: no network, moves or resyncs; relays are a formula; bytes not counted.
- The box was shared with other long jobs; timing runs waited for the timing lock, and the 1-minute load average at their start was 3.5 to 3.8, lagging jobs that had just ended.

## How to run

```sh
./run.sh quick     # small seeded runs of both parts and every planted bug, and one timing pass (a minute or two)
./run.sh sims      # the seeded runs behind the tables (about 15 minutes)
./run.sh timing    # the two benches, three runs each
./run.sh summary   # results/summary.md from the JSON lines
```

`SP` names a scratch folder holding `bin/timing` and `bin/heavy` (the box's locks); without it the locks are skipped. Raw results: `results/sample.jsonl` (one line a seed), `results/sample-runs.jsonl` (one line a world or bug), `results/clientmerge.jsonl`, `results/timing.jsonl`.
