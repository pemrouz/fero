## D1 and D2: count-by and exact sum-by from the change stream

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

## T1: a top-k per share with a bounded buffer, and the merge of the shares

| groups | shares | k | kp | kmax | planted | seeds | failed | checks | changes | refills (of them restarts) | rows scanned by refills | largest buffer |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 4 | 4 | 10 | 12 | 24 | — | 1,000 | 0 | 31,000 | 1,384,982 | 7,038 (1,555) | 735,131 | 24 |
| 4 | 4 | 10 | 20 | 40 | — | 1,000 | 0 | 31,000 | 1,410,051 | 5,561 (1,555) | 553,283 | 40 |
| 16 | 3 | 10 | 12 | 24 | — | 1,000 | 0 | 31,000 | 1,418,601 | 5,299 (1,131) | 737,005 | 24 |
| 4 | 4 | 10 | 12 | 24 | — | 1 × 50,000 | 0 | 1,001 | 46,603 | 141 (54) | 19,303 | 24 |
| 4 | 4 | 10 | 12 | 24 | nodrop | 1,000 | 867 | 31,000 | 1,409,886 | 5,572 (1,555) | 554,665 | 24 |
| 4 | 4 | 10 | 12 | 24 | norefill | 1,000 | 725 | 31,000 | 1,410,304 | 5,555 (1,555) | 552,506 | 24 |

## T2: refills of a bounded top-k buffer (k = 10, kmax = 2 kp), per 1e6 changes

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

## Bytes a record, fero v4's codec, frames of 256

| log as is | + before-image of 2 fields (user, cents) | + 3 fields (also score) | + the whole row before | records that need one | an enriched item (key, 2 fields before and after) |
|---|---|---|---|---|---|
| 54.3 B | +13.9 B (+25.6 %) | +23 B (+42.3 %) | +111.4 B (+205.3 %) | 85.1 % | 53.3 B |

## Timed costs (three runs, each alone under the timing lock; range over the runs)

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
