# E-65 X2: results in short

Printed by `src/summarize.mjs` from `sim.jsonl` and `bench.jsonl`. Ranges are over the three timed runs.

## Seeded runs: the real code

| world | mode | seeds | failed | checks | slot moves | copy failures | re-pins | torn commits / multi-slot commits seen | peak saved images | seconds |
|---|---|---|---|---|---|---|---|---|---|---|
| default | none | 1,000 | 0 | 987,316 | 9,190 | 1,907 | - | - | - | 3.02 |
| wide | none | 300 | 0 | 491,934 | 4,099 | 826 | - | - | - | 1.931 |
| one | none | 300 | 0 | 296,471 | 0 | 571 | - | - | - | 1.048 |
| long | none | 100 | 0 | 278,606 | 10,897 | 2,145 | - | - | - | 3.344 |
| stress | none | 2,000 | 0 | 562,913 | 14,826 | 7,471 | - | - | - | 14.574 |
| hard | none | 1,000 | 0 | 150,838 | 19,538 | 11,779 | - | - | - | 6.906 |
| default | slot | 1,000 | 0 | 602,559 | 8,312 | 1,724 | - | 29,045 / 160,261 | 18 | 4.774 |
| wide | slot | 300 | 0 | 362,352 | 4,008 | 819 | - | 14,232 / 57,853 | 3 | 4.043 |
| one | slot | 300 | 0 | 181,714 | 0 | 523 | - | 9,059 / 49,613 | 3 | 2.023 |
| long | slot | 100 | 0 | 305,754 | 10,897 | 2,145 | - | 16,823 / 38,918 | 0 | 8.634 |
| stress | slot | 2,000 | 0 | 380,002 | 14,247 | 7,207 | - | 58,535 / 754,645 | 24 | 9.336 |
| hard | slot | 1,000 | 0 | 108,138 | 21,446 | 12,858 | - | 23,063 / 231,560 | 95 | 6.332 |
| default | cut | 1,000 | 0 | 557,870 | 8,964 | 1,817 | 91 | 0 / 120,010 | 500 | 5.82 |
| wide | cut | 300 | 0 | 301,712 | 4,523 | 906 | 80 | 0 / 37,662 | 384 | 4.617 |
| one | cut | 300 | 0 | 166,077 | 0 | 510 | 0 | 0 / 36,095 | 1,140 | 1.615 |
| long | cut | 100 | 0 | 190,295 | 10,997 | 2,265 | 124 | 0 / 12,616 | 635 | 11.478 |
| stress | cut | 2,000 | 0 | 379,754 | 17,207 | 8,360 | 1,194 | 0 / 703,950 | 537 | 16.533 |
| hard | cut | 1,000 | 0 | 108,379 | 20,498 | 12,352 | 859 | 0 / 209,341 | 360 | 7.274 |

## Seeded runs: planted bugs (failed seeds of those run)

| mode | bug | world | seeds | failed | first failure |
|---|---|---|---|---|---|
| none | noseen | hard | 1,000 | 985 | not-current k11 |
| none | noseen | default | 1,000 | 82 | missed k5p |
| none | nofollow | hard | 1,000 | 987 | missed k4 |
| none | nofollow | default | 1,000 | 974 | missed ka |
| none | restart | hard | 1,000 | 949 | twice k14 |
| none | restart | default | 1,000 | 288 | twice k13 |
| none | maporder | hard | 1,000 | 985 | twice k2jé |
| none | maporder | default | 1,000 | 523 | missed kjo |
| slot | noseen | hard | 1,000 | 905 | below-start 0 |
| slot | noseen | default | 1,000 | 120 | below-start 7 |
| slot | nobuffer | hard | 1,000 | 899 | slot-handed 1 |
| slot | nobuffer | default | 1,000 | 262 | slot-handed 42 |
| slot | dropnosave | hard | 1,000 | 960 | row 0 |
| slot | dropnosave | default | 1,000 | 216 | row 24 |
| slot | everysave | hard | 1,000 | 997 | row 0 |
| slot | everysave | default | 1,000 | 47 | row 59 |
| cut | nopair | hard | 1,000 | 766 | torn 1 |
| cut | nopair | default | 1,000 | 99 | slot-handed 5 |
| cut | oldpair | hard | 1,000 | 63 | torn 0 |
| cut | oldpair | default | 1,000 | 0 |  |
| cut | dropnosave | hard | 1,000 | 996 | count 0 |
| cut | dropnosave | default | 1,000 | 979 | count 33 |
| cut | opennosave | hard | 1,000 | 839 | count 0 |
| cut | opennosave | default | 1,000 | 26 | count 51 |
| cut | everysave | hard | 1,000 | 1,000 | count 0 |
| cut | everysave | default | 1,000 | 1,000 | row 3 |
| cut | localpin | hard | 1,000 | 985 | count 0 |
| cut | localpin | default | 1,000 | 430 | count 60 |
| cut | pinnotcarried | hard | 1,000 | 848 | count 0 |
| cut | pinnotcarried | default | 1,000 | 48 | count 47 |
| cut | nofloor | hard | 1,000 | 998 | row 0 |
| cut | nofloor | default | 1,000 | 19 | count 1 |
| cut | oldpair | stress | 2,000 | 16 | torn 0 |

## The scan, timed (rows looked at per second; CPU per row; memory)

| rows | scan | runs | seconds | rows/s | asking process ns/row (CPU) | servers ns/row (CPU, all four) | asking heap at peak MB (before) | MB received | checks ok | load at start |
|---|---|---|---|---|---|---|---|---|---|---|
| 10,000,000 | base | 3 | 11.98 to 13.42 | 745,400 to 834,550 | 1,259 to 1,376 | 1,093 to 1,239 | 32.6 to 58.6 (4.8) | 1,345.6 | yes | 1.96 to 4.99 |
| 10,000,000 | proj | 3 | 4.10 to 4.79 | 2,088,529 to 2,439,417 | 422 to 491 | 298 to 397 | 38.2 to 45.1 (4.1) | 160.8 | yes | 1.96 to 4.99 |
| 10,000,000 | col | 3 | 0.51 to 0.62 | 16,249,624 to 19,649,586 | 17 to 23 | 161 to 199 | 8.3 to 9.0 (4.2) | 76.5 | yes | 1.96 to 4.99 |
| 10,000,000 | filter10 | 3 | 1.27 to 1.47 | 6,796,844 to 7,853,747 | 126 to 143 | 225 to 267 | 31.0 to 39.0 (4.2) | 134.7 | yes | 1.96 to 4.99 |
| 10,000,000 | seq | 3 | 12.98 to 14.41 | 693,812 to 770,696 | 1,276 to 1,405 | 917 to 1,036 | 31.8 to 32.4 (4.2) | 1,345.6 | yes | 1.96 to 4.99 |
| 10,000,000 | rowiter | 3 | 13.88 to 17.33 | 576,922 to 720,691 | 1,430 to 1,776 | 897 to 1,122 | 30.0 to 34.4 (4.2) | 1,345.6 | yes | 1.96 to 4.99 |
| 10,000,000 | median | 3 | 1.36 to 1.60 | 6,236,751 to 7,357,128 | 102 to 120 | 166 to 185 | 7.3 to 9.2 (4.3) | 76.5 | yes | 1.96 to 4.99 |
| 10,000,000 | workers2 | 3 | 7.34 to 8.50 | 1,176,595 to 1,362,381 | 1,425 to 1,574 | 941 to 1,098 | 4.7 to 4.8 (4.3) | 0.0 | yes | 1.96 to 4.99 |
| 10,000,000 | workers4 | 3 | 5.97 to 6.86 | 1,457,179 to 1,675,761 | 1,424 to 1,615 | 834 to 971 | 4.8 (4.4) | 0.0 | yes | 1.96 to 4.99 |
| 10,000,000 | none+w | 3 | 13.01 to 14.06 | 711,079 to 768,677 | 1,350 to 1,446 | 1,495 to 1,614 | 29.1 to 35.4 (4.8) | 1,345.6 | yes | 2.85 to 4.04 |
| 10,000,000 | cut+w | 3 | 11.50 to 13.82 | 723,640 to 869,838 | 1,170 to 1,393 | 1,510 to 1,848 | 30.0 to 36.6 (4.1) | 1,345.6 | yes | 2.85 to 4.04 |
| 2,000,000 | p100 | 3 | 2.60 to 3.12 | 641,694 to 770,109 | 1,380 to 1,604 | 1,258 to 1,599 | 21.3 to 29.3 (4.8) | 268.0 | yes | 3.29 to 4.06 |
| 2,000,000 | p1000 | 3 | 2.51 to 3.14 | 636,342 to 795,884 | 1,338 to 1,612 | 932 to 1,135 | 25.9 to 47.2 (4.1 to 4.2) | 266.6 | yes | 3.29 to 4.06 |
| 2,000,000 | p10000 | 3 | 2.25 to 2.47 | 809,078 to 890,208 | 1,270 to 1,385 | 766 to 885 | 31.9 to 43.9 (4.1 to 4.2) | 266.4 | yes | 3.29 to 4.06 |
| 2,000,000 | c1 | 3 | 2.37 to 2.51 | 795,842 to 843,563 | 1,239 to 1,307 | 937 to 1,041 | 31.4 to 60.4 (4.1) | 266.6 | yes | 3.29 to 4.06 |
| 2,000,000 | c8 | 3 | 2.46 to 2.54 | 787,273 to 811,839 | 1,270 to 1,323 | 928 to 1,027 | 25.7 to 28.0 (4.2) | 266.6 | yes | 3.29 to 4.06 |
| 2,000,000 | seq-c8 | 3 | 2.49 to 2.61 | 766,083 to 804,405 | 1,281 to 1,339 | 891 to 1,026 | 36.5 to 47.5 (4.2) | 266.6 | yes | 3.29 to 4.06 |
| 2,000,000 | col-seq | 3 | 0.34 to 0.43 | 4,669,018 to 5,948,276 | 25 to 45 | 190 to 232 | 8.4 to 8.7 (4.2) | 15.3 | yes | 3.29 to 4.06 |
| 2,000,000 | slow | 3 | 5.21 to 5.58 | 358,391 to 384,178 | 2,662 to 2,852 | 885 to 1,112 | 26.1 to 27.3 (4.2) | 266.6 | yes | 3.29 to 4.06 |

## Writes during the scan

| rows | scan | writes/s a group | runs | seconds | writes during the scan | peak images kept (all groups) | note |
|---|---|---|---|---|---|---|---|
| 10,000,000 | none+w | 5,000 | 3 | 13.01 to 14.06 | 1,003,800 to 1,084,400 | 0 |  |
| 10,000,000 | cut+w | 5,000 | 3 | 11.50 to 13.82 | 871,200 to 1,038,000 | 223,609 to 254,740 | groups whose sum differs from the pin's: 0 of 16 |

Setup: 10,000,000 and 2,000,000 rows over 16 groups in 4 server processes; build 1.3 to 8.4 s; Node v22.22.0.

## A server reading its own groups (no wire)

| way | rows | runs | ms | ns a row |
|---|---|---|---|---|
| map | 2,500,000 | 3 | 57.3 to 62.2 | 23 to 25 |
| paged | 2,500,000 | 3 | 252.1 to 282.9 | 101 to 113 |
| rowiter | 2,500,000 | 3 | 719.4 to 786.8 | 288 to 315 |
| sortonly | 2,500,000 | 3 | 160.8 to 198.7 | 64 to 79 |

## A pin on a copy that folds with data (one group of 625,000 rows; field updates in batches of 256)

Each mode appears twice in a run (the order nosink, sink, pin, pinall, nosink, sink); both are in the range.

| mode | lines | µs a record (median of rounds) | images kept at the end of a round | deltas the sink saw in a round |
|---|---|---|---|---|
| nosink | 6 | 1.713 to 1.957 | 0 | 0 |
| sink | 6 | 1.585 to 1.921 | 0 | 199,959 to 199,960 |
| pin | 3 | 2.099 to 2.314 | 85,733 | 0 |
| pinall | 3 | 2.040 to 2.174 | 170,990 | 0 |

Memory: 78,336 images kept, 127 B each (heap after collection, with and without them).

Memory: 312,576 images kept, 127 B each (heap after collection, with and without them).

A pin by copying the group's map of rows (rows shared): 177.9 to 183.6 ms and 47 B a row (28.0 MB).
