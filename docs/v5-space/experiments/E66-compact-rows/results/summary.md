## One read of a held row, ns, at 1000000 rows (3 runs)

| Form | one field | all eight fields | compare two rows |
|---|---|---|---|
| data | 395.8 to 518.1 | 1324.5 to 1519.6 | 536.2 to 643.3 |
| mat | 2684.8 to 2708.7 | 3143.8 to 3207.4 | 3328.4 to 3379.6 |
| fly | 294.7 to 364.5 | 2692.7 to 2950.3 | 474.6 to 517.8 |
| proxy | 349.7 to 433.8 | 2643.9 to 3108.4 | 512.9 to 637.2 |
| fly-map | 519.6 to 613.9 | 3116.3 to 3179.9 | 798.1 to 894.7 |
| id | 308.8 to 345.5 | 2023.9 to 2127.6 | 518.8 to 557.1 |
| id-map | 545.9 to 588.1 | 2257.1 to 2478.3 | 568.1 to 833.3 |

loadavg at start: 0.23 0.09 0.03; 0.35 0.12 0.04; 1.00 0.44 0.17; 1.30 0.52 0.20; 1.08 0.72 0.32; 1.07 0.73 0.33

## One forced full collection (three in a row per run; the range is over every collection of every run)

| Form | Rows | Pause ms | Heap MB | Off-heap MB | RSS MB |
|---|---|---|---|---|---|
| map | 1000000 | 36.2 to 50.8 | 62 | 238 | NaN to NaN |
| ix | 1000000 | 9.1 to 12.9 | 12 | 238 | NaN to NaN |
| keys | 1000000 | 30.8 to 42.9 | 55 | 2 | NaN to NaN |
| map | 5000000 | 157.1 to 334.2 | 350 | 1150 | NaN to NaN |
| ix | 5000000 | 7.5 to 12.2 | 13 | 1150 | NaN to NaN |
| keys | 5000000 | 176.4 to 280 | 343 | 2 | NaN to NaN |

loadavg at start: 0.87 0.36 0.13; 0.87 0.36 0.13; 0.87 0.36 0.13; 0.90 0.39 0.15; 0.91 0.41 0.16; 1.00 0.44 0.17; 1.05 0.66 0.29; 1.05 0.66 0.29; 1.05 0.66 0.29; 1.10 0.70 0.31; 1.08 0.71 0.32; 1.08 0.72 0.32; 1.01 0.81 0.40; 1.01 0.81 0.40; 1.01 0.81 0.40; 1.01 0.82 0.41; 1.01 0.83 0.42; 1.00 0.83 0.42

## Review: a row made for the fixed shape, ns, at 1000000 rows (3 runs)

| Form | one field | all eight fields | keep the row |
|---|---|---|---|
| data | 454.9 to 491.4 | 1409.4 to 1564.6 | 455.6 to 496.6 |
| mat | 2684.7 to 2808.8 | 3016.2 to 3211.4 | 2624 to 2754.6 |
| lit | 803.6 to 873.3 | 1248.6 to 1525.4 | 848.2 to 890.4 |
| lit-frz | 935.8 to 977.2 | 1238.6 to 1407.8 | 966.3 to 1081.7 |
| lit-notext | 376.6 to 512 | 747 to 824.4 | 480.3 to 526.4 |
| lit-frz-map | 1160 to 1234 | 1687.1 to 1755.3 | 1199.4 to 1306 |
| fly | 267 to 339.9 | 2717.5 to 3037.8 | 288.5 to 331.2 |
| fly-map | 554.6 to 583.4 | 3120.6 to 3183.7 | 517.3 to 620.6 |

loadavg at start: 0.16 0.23 0.31; 0.29 0.25 0.31; 1.24 0.62 0.44; 1.21 0.63 0.45; 1.02 0.78 0.54; 1.16 0.82 0.55

## Review: a row made for the fixed shape, ns, at 10000 rows (3 runs)

| Form | one field | all eight fields | keep the row |
|---|---|---|---|
| data | 58.7 to 64.5 | 264.8 to 297.6 | 42 to 56.5 |
| mat | 692.9 to 829.4 | 1033.1 to 1054.1 | 854 to 882 |
| lit | 149.2 to 185.3 | 354.8 to 389 | 177.8 to 186.9 |
| lit-frz | 199.3 to 219.7 | 339.8 to 402 | 216.4 to 250.9 |
| lit-notext | 58.7 to 82.3 | 234 to 277.7 | 66.9 to 83 |
| lit-frz-map | 200.1 to 264.3 | 459.7 to 502.7 | 187 to 261.9 |
| fly | 77.2 to 81.5 | 889.4 to 963.2 | 81.1 to 88.2 |
| fly-map | 70.9 to 86.4 | 899.3 to 990.6 | 72.8 to 83.1 |

loadavg at start: 1.02 0.92 0.64; 1.02 0.92 0.64; 1.01 0.93 0.65; 1.01 0.93 0.65; 1.01 0.94 0.66; 1.01 0.94 0.66

Every form checked against data's own rows: 55000 fields at 1000000 rows, 0 differ

## Review: the key index grown from empty to 16777217 keys (3 runs)

A stall is one insert that took 1 ms or more. The rebuild columns count stalls with no collection in them; the four longest that came at the same key count in every run are listed. ix keeps its index in typed arrays, off the heap.

| Form | Keys inserted | Stopped at | Longest rebuild stall, ms | The four longest, by key count (ms) | Longest stall with a collection, ms | Insert all, ms | Heap MB at the end |
|---|---|---|---|---|---|---|---|
| map | 16777216 | 16777216, 16777216, 16777216 | 631 to 687.7 | 8388608: 631 to 687.7; 4194304: 248.8 to 303.8; 2097152: 122.7 to 148.5; 1048576: 58.8 to 83.7 | 46.3 to 513.6 | 17507 to 17884 | 893 to 894 |
| blocks | 16777217 | —, —, — | 15.3 to 19.8 | none in every run | 10.7 to 205 | 17231 to 18014 | 1522 to 1564 |
| ix | 16777217 | —, —, — | 21.6 to 23.4 | 524288: 21.6 to 23.4; 262144: 10 to 11.1; 131072: 4.8 to 5.6 | 2741.9 to 3102.7 | 11896 to 12473 | 7 |

loadavg at start: 0.86 0.46 0.38; 0.89 0.49 0.39; 1.29 0.60 0.44; 1.04 0.74 0.51; 1.03 0.75 0.52; 1.02 0.77 0.53; 1.03 0.87 0.60; 1.02 0.88 0.61; 1.37 0.97 0.64

