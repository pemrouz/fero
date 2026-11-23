# E-65 X5: summary of the raw results

Made by `./run.sh summary` from the JSON lines in this folder.

## Slot sample (`sample.mjs`, checked)

Each seed: one resource and one stream of 20,000 writes, folded by 20 independent picks of k slots. A seed fails if any held row differs from the oracle (exact check), or if any estimate's 95 % interval holds the truth in fewer than 14 of 20 picks.

| Config | Seeds | Failed | Cover: count | sum | mean | paid | median | p90 |
|---|---|---|---|---|---|---|---|---|
| real, moderate, k 256, 30000+ partitions | 100 | 0 | 94.5 % | 93.4 % | 92.9 % | 94.4 % | 94.8 % | 92.5 % |
| real, moderate, k 256, 2000+ partitions | 100 | 1 | 92.1 % | 91.2 % | 91.6 % | 93.7 % | 93.7 % | 92.1 % |
| real, heavy, k 256, 30000+ partitions | 100 | 6 | 92.9 % | 85.8 % | 86.5 % | 92.7 % | 93.6 % | 88.0 % |
| real, heavy, k 1024, 30000+ partitions | 50 | 1 | 94.3 % | 90.2 % | 89.5 % | 94.0 % | 95.3 % | 90.3 % |
| real, moderate, k 64, 30000+ partitions | 50 | 0 | 92.6 % | 92.1 % | 93.1 % | 93.4 % | 93.4 % | 92.3 % |
| bug noscale, moderate, k 256, 30000+ partitions | 100 | 100 | 0.0 % | 0.0 % | 92.9 % | 94.4 % | 94.8 % | 92.5 % |
| bug rowvar, moderate, k 256, 30000+ partitions | 100 | 100 | 53.0 % | 55.2 % | 57.0 % | 71.7 % | 61.1 % | 63.6 % |
| bug hotpick, moderate, k 256, 30000+ partitions | 100 | 100 | 0.0 % | 0.0 % | 95.0 % | 98.0 % | 96.0 % | 96.0 % |
| bug window, moderate, k 256, 30000+ partitions | 100 | 100 | 94.5 % | 93.4 % | 16.3 % | 94.0 % | 18.6 % | 43.8 % |
| bug lostdelete, moderate, k 256, 30000+ partitions | 100 | 100 | 87.3 % | 89.0 % | 93.7 % | 94.5 % | 94.1 % | 93.8 % |
| bug skipempty, moderate, k 256, 2000+ partitions | 100 | 100 | 0.0 % | 0.5 % | 91.7 % | 93.8 % | 93.7 % | 92.1 % |

Real code, per seed (ranges over seeds): rows at the end, rows held, share of writes sent to the asker, interval half-width as a share of the truth, and two things a sample cannot estimate.

| Config | Rows | Held | Sent | ± count | ± sum | ± mean | ± median | ± p90 | distinct sku scaled / true | sample max / true max |
|---|---|---|---|---|---|---|---|---|---|---|
| moderate, k 256, many partitions | 58161 to 114088 | 3639 to 7092 | 6.12 to 6.38 % | 5.6 to 9.2 % | 6.9 to 11.9 % | 3.7 to 6.9 % | 4 to 6.6 % | 5 to 9.8 % | 8.26 to 12.129 | 0.376 to 0.854 |
| moderate, k 256, few partitions | 6219 to 10470 | 375 to 661 | 5.8 to 6.64 % | 17.6 to 32.1 % | 21.1 to 44.8 % | 11.4 to 20.3 % | 11.5 to 22.1 % | 14.2 to 44 % | 1.629 to 2.264 | 0.226 to 0.8 |
| heavy, k 256, many partitions | 103133 to 207156 | 6362 to 12891 | 6.15 to 6.36 % | 10.3 to 18 % | 15.9 to 41 % | 12.5 to 32.9 % | 15.1 to 27.2 % | 15.4 to 138 % | 11.473 to 14.776 | 0.116 to 0.742 |
| heavy, k 1024, many partitions | 103133 to 207156 | 26302 to 51933 | 24.8 to 25.19 % | 5.3 to 8.1 % | 8 to 15.5 % | 6.5 to 12.8 % | 7.4 to 11.7 % | 7.8 to 14.8 % | 3.978 to 4 | 0.225 to 0.909 |
| moderate, k 64, many partitions | 58161 to 114088 | 886 to 1786 | 1.51 to 1.64 % | 12.1 to 18.9 % | 13.8 to 23.1 % | 7.4 to 11.7 % | 8.2 to 12.3 % | 9.5 to 24.1 % | 10.359 to 19.252 | 0.296 to 0.663 |

## Clients that merge (`clientmerge.mjs`, counted and checked)

| G | Scores | Bug | Seeds | Failed | Top 10: partial frames a write | merged frames a write | ratio | Sums: partial | merged |
|---|---|---|---|---|---|---|---|---|---|
| 16 | random | none | 5 | 0 | 0.00317 to 0.00349 | 0.00016 to 0.00023 | 14.3 to 20.4 | 0.99987 to 0.99991 | 0.99987 to 0.99991 |
| 16 | rising | none | 5 | 0 | 1 | 1 | 1 | 0.99989 to 0.99991 | 0.99989 to 0.99991 |
| 16 | random | answeronly | 5 | 5 | 0.00317 to 0.00349 | 0.00016 to 0.00023 | 14.3 to 20.4 | 0.99987 to 0.99991 | 0.99987 to 0.99991 |
| 16 | rising | answeronly | 5 | 0 | 1 | 1 | 1 | 0.99989 to 0.99991 | 0.99989 to 0.99991 |
| 256 | random | none | 2 | 0 | 0.0499 to 0.05088 | 0.00016 to 0.00023 | 217 to 318 | 0.9999 to 0.99991 | 0.9999 to 0.99991 |
| 256 | rising | none | 2 | 0 | 1 | 1 | 1 | 0.99989 | 0.99989 |

Sends a write by placement, G = 16, seed 1 (M: one merger; MR: a merger and one relay per 1,000 clients; CM: clients merge). "Busiest" is the one process that sends the most.

| View | Clients | M busiest | MR busiest | CM busiest | M total | CM total | Frames a client takes, M / CM | Links a client, M / CM |
|---|---|---|---|---|---|---|---|---|
| top 10, random | 100 | 0.023 | 0.023 | 0.031 | 0.026 | 0.328 | 0.00023 / 0.00328 | 1 / 16 |
| top 10, random | 1000 | 0.23 | 0.23 | 0.312 | 0.233 | 3.28 | 0.00023 / 0.00328 | 1 / 16 |
| top 10, random | 10000 | 2.3 | 0.23 | 3.116 | 2.303 | 32.8 | 0.00023 / 0.00328 | 1 / 16 |
| top 10, rising | 100 | 100 | 100 | 6.4 | 101 | 100 | 1 / 1 | 1 / 16 |
| top 10, rising | 1000 | 1000 | 1000 | 64 | 1001 | 1000 | 1 / 1 | 1 / 16 |
| top 10, rising | 10000 | 10000 | 1000 | 640 | 10001 | 10000 | 1 / 1 | 1 / 16 |
| sums | 100 | 99.991 | 99.991 | 6.249 | 100.991 | 99.991 | 0.99991 / 0.99991 | 1 / 16 |
| sums | 1000 | 999.91 | 999.91 | 62.494 | 1000.91 | 999.91 | 0.99991 / 0.99991 | 1 / 16 |
| sums | 10000 | 9999.1 | 999.91 | 624.944 | 10000.1 | 9999.1 | 0.99991 / 0.99991 | 1 / 16 |

## Timing (measured, each run alone under the timing lock)

Runs: 3. Load average (1 min) at each run's start: 3.75, 3.53, 3.53.

| Cell | Range over runs |
|---|---|
| copy: drop a record of a slot not held (bitmap test) | 1.53 to 1.85 ns a record |
| asker, 62500 rows held: fold one sampled update (per-slot sums and sorted columns) | 278 to 341 ns |
| asker, 62500 rows held: one read (count, mean with intervals; median with Woodruff's interval) | 608.2 to 638.2 µs |
| asker, 625000 rows held: fold one sampled update (per-slot sums and sorted columns) | 1218 to 1531 ns |
| asker, 625000 rows held: one read (count, mean with intervals; median with Woodruff's interval) | 714.9 to 837.6 µs |
| client: merge one partial top-10 frame, G = 16 | 664 to 706 ns |
| client: merge one partial top-10 frame, G = 256 | 6962 to 7328 ns |
