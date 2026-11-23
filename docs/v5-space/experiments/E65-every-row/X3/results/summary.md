# E-65 X3 results

Made by `src/summarize.mjs` from `sim.jsonl` and `bench.jsonl`. Seeded runs are *(checked)*; timed cells are *(measured)*, a range over three runs, each the median of 5 rounds.

## Lawful folds (the six folds of `src/folds.mjs`), every world

| world | seeds | failed | flagged by fero | checks | paired moves | slots moved | resyncs (at cut) | outages | rebuilds | deploys | deploy stall steps | rescans | kept by hint |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 4 (400 commits, 300 keys) | 1,000 | 0 | 0 | 397,391 | 1,632 | 39,712 | 1972 (947) | 395 | 378 | 0 | 0 | 499,907 | 560 |
| 16 (400 commits, 300 keys) | 300 | 0 | 0 | 117,465 | 492 | 11,061 | 626 (343) | 135 | 118 | 0 | 0 | 141,942 | 145 |
| elastic (400 commits, 300 keys) | 500 | 0 | 0 | 194,641 | 289 | 101,192 | 916 (323) | 183 | 201 | 0 | 0 | 318,124 | 338 |
| elastic, deploy (overlap 0) (400 commits, 300 keys) | 500 | 0 | 0 | 188,007 | 289 | 101,192 | 869 (317) | 183 | 125 | 500 | 11,506 | 136,543 | 145 |
| 4, deploy (overlap 300) (400 commits, 300 keys) | 300 | 0 | 0 | 111,641 | 499 | 11,377 | 556 (274) | 135 | 50 | 300 | 21,359 | 62,237 | 79 |
| 4, no keeps (400 commits, 300 keys) | 300 | 0 | 0 | 119,120 | 499 | 11,377 | 625 (301) | 135 | 120 | 0 | 0 | 150,603 | 0 |
| 4, flat (400 commits, 300 keys) | 300 | 0 | 0 | 119,120 | 499 | 11,377 | 625 (301) | 135 | 120 | 0 | 0 | 150,445 | 168 |
| 16, deploy (overlap 0) (20000 commits, 3000 keys) | 1 | 0 | 0 | 17,060 | 70 | 1,421 | 117 (71) | 29 | 22 | 1 | 288 | 33,458 | 674 |
| elastic (20000 commits, 3000 keys) | 1 | 0 | 0 | 18,503 | 82 | 9,130 | 106 (46) | 19 | 19 | 0 | 0 | 7,411 | 352 |
| 4, deploy (overlap 0) (400 commits, 300 keys) | 300 | 0 | 0 | 92,937 | 499 | 11,377 | 482 (240) | 135 | 50 | 300 | 51,165 | 62,304 | 76 |

## Planted builder bugs (fero's side), failing seeds

| bug | world | failed | of seeds | first failure |
|---|---|---|---|---|
| nopair | 4 (400 commits, 300 keys) | 172 | 300 | roomStats "r43" |
| resyncadd | 4 (400 commits, 300 keys) | 264 | 300 | roomStats(full) "r29" |
| norescan | 4 (400 commits, 300 keys) | 256 | 300 | hll "*" |
| mixver | 4, deploy (overlap 0) (400 commits, 300 keys) | 300 | 300 | hist 40 |

## An author's mistakes: who sees them (seeds out of the run's seeds)

| mistake | seeds | oracle saw a wrong answer | wrong answers / checks | self-check at build | law it named | audit | resync check | any of fero's checks | a move changed an answer |
|---|---|---|---|---|---|---|---|---|---|
| avgmeans | 300 | 300 | 87.6 % | 300 | associative 300 | 300 | 153 | 300 | 168 |
| firstwins | 300 | 300 | 92.3 % | 300 | commutative 300 | 300 | 138 | 300 | 49 |
| floatsum | 300 | 300 | 5.6 % | 300 | remove-undoes 213, associative 87 | 258 | 64 | 300 | 9 |
| badremove | 300 | 300 | 71.9 % | 300 | remove-undoes 300 | 300 | 146 | 300 | 163 |
| maxremove | 300 | 300 | 24.0 % | 300 | remove-undoes 300 | 300 | 130 | 300 | 25 |
| badkeeps | 300 | 23 | 0.1 % | 300 | keeps 300 | 8 | 1 | 300 | 0 |
| impure | 300 | 300 | 67.0 % | 300 | emit-not-pure 300 | 300 | 158 | 300 | 30 |
| badempty | 300 | 203 | 24.8 % | 300 | identity 300 | 0 | 0 | 300 | 0 |
| mutsecond | 300 | 300 | 79.4 % | 300 | combine-changed-second 300 | 0 | 167 | 300 | 8 |

## The partial's work per write on a group copy (N rows, G groups, 4,096 slots)

| N | G | rows a slot | fold | class | form | µs a write | rows rescanned a write | combines a write | frame parts a write | runs |
|---|---|---|---|---|---|---|---|---|---|---|
| 100,000 | 4 | 24 | roomStats | inv | default | 1.282 to 1.895 | 0 | 0 | 1.984 | 3 |
| 100,000 | 4 | 24 | hist | inv | default | 0.941 to 1.154 | 0 | 0 | 1.554 | 3 |
| 100,000 | 4 | 24 | distinct | inv | default | 2.866 to 3.566 | 0 | 0 | 0.971 | 3 |
| 100,000 | 4 | 24 | maxByRoom | mon | default | 10.969 to 13.092 | 0.15 | 32.5 | 1.676 | 3 |
| 100,000 | 4 | 24 | maxByRoom | mon | nokeeps | 12.378 to 13.804 | 0.31 | 38.2 | 1.676 | 3 |
| 100,000 | 4 | 24 | maxByRoom | mon | flat | 96.96 to 134.248 | 0.14 | 473.1 | 1.68 | 3 |
| 100,000 | 4 | 24 | top | mon | default | 15.403 to 19.607 | 2.54 | 12.6 | 0.253 | 3 |
| 100,000 | 4 | 24 | top | mon | nokeeps | 65.409 to 70.894 | 18.43 | 73.4 | 0.253 | 3 |
| 100,000 | 4 | 24 | top | mon | flat | 664.274 to 791.149 | 2.58 | 890.9 | 0.253 | 3 |
| 100,000 | 4 | 24 | hll | mon | default | 39.288 to 47.947 | 22.48 | 79.5 | 0 | 3 |
| 100,000 | 4 | 24 | hll | mon | nokeeps | 45.513 to 50.272 | 25.47 | 89.5 | 0 | 3 |
| 100,000 | 4 | 24 | hll | mon | flat | 379.852 to 423.064 | 22.64 | 1,046.7 | 0 | 3 |
| 100,000 | 16 | 24 | roomStats | inv | default | 1.297 to 1.803 | 0 | 0 | 1.984 | 3 |
| 100,000 | 16 | 24 | hist | inv | default | 0.732 to 1.029 | 0 | 0 | 1.556 | 3 |
| 100,000 | 16 | 24 | distinct | inv | default | 2.92 to 3.309 | 0 | 0 | 0.972 | 3 |
| 100,000 | 16 | 24 | maxByRoom | mon | default | 6.061 to 8.554 | 0.14 | 15.1 | 1.681 | 3 |
| 100,000 | 16 | 24 | maxByRoom | mon | nokeeps | 7.746 to 8.269 | 0.31 | 17.7 | 1.681 | 3 |
| 100,000 | 16 | 24 | maxByRoom | mon | flat | 25.837 to 28.638 | 0.14 | 119.4 | 1.679 | 3 |
| 100,000 | 16 | 24 | top | mon | default | 10.395 to 11.963 | 2.5 | 9.6 | 0.253 | 3 |
| 100,000 | 16 | 24 | top | mon | nokeeps | 41.343 to 46.516 | 18.36 | 52.9 | 0.253 | 3 |
| 100,000 | 16 | 24 | top | mon | flat | 97.623 to 134.767 | 2.42 | 226.1 | 0.248 | 3 |
| 100,000 | 16 | 24 | hll | mon | default | 28.631 to 32.096 | 22.3 | 58 | 0 | 3 |
| 100,000 | 16 | 24 | hll | mon | nokeeps | 29.609 to 35.916 | 25.29 | 65.3 | 0 | 3 |
| 100,000 | 16 | 24 | hll | mon | flat | 71.728 to 85.161 | 22.39 | 278.5 | 0 | 3 |
| 1,000,000 | 4 | 244 | roomStats | inv | default | 2.028 to 2.158 | 0 | 0 | 1.984 | 3 |
| 1,000,000 | 4 | 244 | hist | inv | default | 1.231 to 1.522 | 0 | 0 | 1.56 | 3 |
| 1,000,000 | 4 | 244 | distinct | inv | default | 3.836 to 4.467 | 0 | 0 | 0.973 | 3 |
| 1,000,000 | 4 | 244 | maxByRoom | mon | default | 8.904 to 10.257 | 0.63 | 18.3 | 1.679 | 3 |
| 1,000,000 | 4 | 244 | maxByRoom | mon | nokeeps | 21.223 to 23.221 | 2.98 | 59.2 | 1.679 | 3 |
| 1,000,000 | 4 | 244 | maxByRoom | mon | flat | 324.402 to 383.441 | 0.6 | 1,072.9 | 1.665 | 3 |
| 1,000,000 | 4 | 244 | top | mon | default | 13.376 to 15.293 | 2.57 | 5.9 | 0.252 | 3 |
| 1,000,000 | 4 | 244 | top | mon | nokeeps | 302.514 to 342.337 | 177.49 | 232.4 | 0.252 | 3 |
| 1,000,000 | 4 | 244 | top | mon | flat | 817.033 to 906.092 | 2.21 | 877.7 | 0.255 | 3 |
| 1,000,000 | 4 | 244 | hll | mon | default | 90.169 to 96.715 | 86.47 | 111 | 0 | 3 |
| 1,000,000 | 4 | 244 | hll | mon | nokeeps | 219.246 to 246.664 | 245.09 | 309.1 | 0 | 3 |
| 1,000,000 | 4 | 244 | hll | mon | flat | 418.748 to 535.992 | 84.03 | 1,108.7 | 0 | 3 |
| 1,000,000 | 16 | 244 | roomStats | inv | default | 1.437 to 1.744 | 0 | 0 | 1.983 | 3 |
| 1,000,000 | 16 | 244 | hist | inv | default | 1.011 to 1.234 | 0 | 0 | 1.559 | 3 |
| 1,000,000 | 16 | 244 | distinct | inv | default | 3.194 to 3.79 | 0 | 0 | 0.972 | 3 |
| 1,000,000 | 16 | 244 | maxByRoom | mon | default | 5.715 to 7.085 | 0.63 | 12.7 | 1.677 | 3 |
| 1,000,000 | 16 | 244 | maxByRoom | mon | nokeeps | 10.599 to 12.809 | 2.98 | 38.7 | 1.677 | 3 |
| 1,000,000 | 16 | 244 | maxByRoom | mon | flat | 64.378 to 71.489 | 0.6 | 267.2 | 1.665 | 3 |
| 1,000,000 | 16 | 244 | top | mon | default | 9.898 to 11.165 | 2.67 | 5.7 | 0.251 | 3 |
| 1,000,000 | 16 | 244 | top | mon | nokeeps | 224.4 to 254.138 | 177.42 | 211.9 | 0.251 | 3 |
| 1,000,000 | 16 | 244 | top | mon | flat | 116.386 to 133.707 | 2.45 | 220.6 | 0.263 | 3 |
| 1,000,000 | 16 | 244 | hll | mon | default | 72.633 to 76.648 | 86.99 | 103.2 | 0 | 3 |
| 1,000,000 | 16 | 244 | hll | mon | nokeeps | 184.064 to 198.016 | 245.12 | 285.1 | 0 | 3 |
| 1,000,000 | 16 | 244 | hll | mon | flat | 137.53 to 153.981 | 88.25 | 344.9 | 0 | 3 |

## The merger's work per write (G groups, B writes folded into one partial frame)

| G | B | fold | class | ns a write | frame parts a write | writes a second (one thread) | runs |
|---|---|---|---|---|---|---|---|
| 4 | 1 | roomStats | inv | 750.7 to 882.9 | 1.982 | 1,132,588 to 1,332,063 | 3 |
| 4 | 16 | roomStats | inv | 624.6 to 670 | 1.55 | 1,492,621 to 1,601,086 | 3 |
| 4 | 256 | roomStats | inv | 78.5 to 82.3 | 0.234 | 12,155,908 to 12,735,903 | 3 |
| 4 | 1 | hist | inv | 262.9 to 346 | 1.571 | 2,890,267 to 3,803,591 | 3 |
| 4 | 16 | hist | inv | 60.6 to 62.7 | 0.478 | 15,948,137 to 16,511,136 | 3 |
| 4 | 256 | hist | inv | 3.5 to 4 | 0.041 | 247,514,882 to 283,039,082 | 3 |
| 4 | 1 | distinct | inv | 366.1 to 576.9 | 0.976 | 1,733,552 to 2,731,852 | 3 |
| 4 | 16 | distinct | inv | 190.3 to 206.3 | 0.063 | 4,847,783 to 5,254,716 | 3 |
| 4 | 256 | distinct | inv | 80.7 to 102.4 | 0.004 | 9,763,883 to 12,390,457 | 3 |
| 4 | 1 | maxByRoom | mon | 983 to 1,189.7 | 1.689 | 840,551 to 1,017,270 | 3 |
| 4 | 16 | maxByRoom | mon | 379.2 to 518.4 | 1.255 | 1,929,107 to 2,637,291 | 3 |
| 4 | 256 | maxByRoom | mon | 53.9 to 90.6 | 0.203 | 11,041,733 to 18,564,766 | 3 |
| 4 | 1 | top | mon | 862.8 to 981.1 | 0.251 | 1,019,301 to 1,158,976 | 3 |
| 4 | 16 | top | mon | 115.3 to 121 | 0.05 | 8,266,727 to 8,673,997 | 3 |
| 4 | 256 | top | mon | 6.4 to 7.7 | 0.004 | 129,911,114 to 155,742,926 | 3 |
| 4 | 1 | hll | mon | 57.7 to 75 | 0 | 13,326,794 to 17,332,944 | 3 |
| 4 | 16 | hll | mon | 3.4 to 6.3 | 0 | 159,670,991 to 290,681,996 | 3 |
| 4 | 256 | hll | mon | 0.2 to 0.3 | 0 | 2,900,849,773 to 5,236,177,953 | 3 |
| 16 | 1 | roomStats | inv | 776.7 to 915.4 | 1.984 | 1,092,409 to 1,287,486 | 3 |
| 16 | 16 | roomStats | inv | 711.7 to 742.3 | 1.543 | 1,347,142 to 1,405,097 | 3 |
| 16 | 256 | roomStats | inv | 109.7 to 149 | 0.234 | 6,712,790 to 9,113,280 | 3 |
| 16 | 1 | hist | inv | 196.2 to 393.9 | 1.565 | 2,539,010 to 5,096,429 | 3 |
| 16 | 16 | hist | inv | 56.5 to 64.9 | 0.471 | 15,405,316 to 17,710,231 | 3 |
| 16 | 256 | hist | inv | 3.6 to 4.5 | 0.041 | 223,864,891 to 277,159,388 | 3 |
| 16 | 1 | distinct | inv | 511.6 to 598.9 | 0.973 | 1,669,748 to 1,954,525 | 3 |
| 16 | 16 | distinct | inv | 178.9 to 209.8 | 0.063 | 4,765,807 to 5,588,370 | 3 |
| 16 | 256 | distinct | inv | 75.2 to 91.8 | 0.004 | 10,887,876 to 13,301,292 | 3 |
| 16 | 1 | maxByRoom | mon | 1,846.9 to 2,322.9 | 1.68 | 430,493 to 541,445 | 3 |
| 16 | 16 | maxByRoom | mon | 1,064.1 to 1,159.6 | 1.246 | 862,356 to 939,804 | 3 |
| 16 | 256 | maxByRoom | mon | 156.8 to 203.5 | 0.205 | 4,912,817 to 6,378,897 | 3 |
| 16 | 1 | top | mon | 2,421.9 to 2,666.9 | 0.259 | 374,974 to 412,900 | 3 |
| 16 | 16 | top | mon | 502.8 to 539.5 | 0.05 | 1,853,645 to 1,989,057 | 3 |
| 16 | 256 | top | mon | 25 to 45 | 0.004 | 22,204,634 to 39,996,094 | 3 |
| 16 | 1 | hll | mon | 64.1 to 87.3 | 0 | 11,455,708 to 15,608,760 | 3 |
| 16 | 16 | hll | mon | 3.7 to 10.8 | 0 | 92,495,470 to 266,879,511 | 3 |
| 16 | 256 | hll | mon | 0.1 to 0.6 | 0 | 1,690,466,325 to 8,126,989,823 | 3 |
| 64 | 1 | roomStats | inv | 1,062.9 to 1,129 | 1.983 | 885,743 to 940,826 | 3 |
| 64 | 16 | roomStats | inv | 789.9 to 933.5 | 1.549 | 1,071,214 to 1,265,973 | 3 |
| 64 | 256 | roomStats | inv | 115.3 to 136.8 | 0.234 | 7,309,782 to 8,671,697 | 3 |
| 64 | 1 | hist | inv | 248.6 to 276.9 | 1.559 | 3,611,236 to 4,022,833 | 3 |
| 64 | 16 | hist | inv | 64.6 to 71.5 | 0.477 | 13,990,827 to 15,470,761 | 3 |
| 64 | 256 | hist | inv | 4.8 to 6 | 0.041 | 167,228,039 to 206,269,669 | 3 |
| 64 | 1 | distinct | inv | 586.6 to 821.1 | 0.97 | 1,217,830 to 1,704,632 | 3 |
| 64 | 16 | distinct | inv | 267.3 to 318.6 | 0.063 | 3,138,919 to 3,741,787 | 3 |
| 64 | 256 | distinct | inv | 105.7 to 113.9 | 0.004 | 8,779,239 to 9,464,787 | 3 |
| 64 | 1 | maxByRoom | mon | 9,215.4 to 9,617.2 | 1.678 | 103,980 to 108,514 | 3 |
| 64 | 16 | maxByRoom | mon | 4,975.4 to 5,617.4 | 1.251 | 178,020 to 200,987 | 3 |
| 64 | 256 | maxByRoom | mon | 940.1 to 1,119.2 | 0.204 | 893,457 to 1,063,694 | 3 |
| 64 | 1 | top | mon | 9,243 to 9,831.9 | 0.254 | 101,710 to 108,190 | 3 |
| 64 | 16 | top | mon | 1,824.1 to 1,909.7 | 0.051 | 523,649 to 548,226 | 3 |
| 64 | 256 | top | mon | 112.4 to 130.5 | 0.004 | 7,660,847 to 8,892,990 | 3 |
| 64 | 1 | hll | mon | 66.2 to 76.6 | 0 | 13,061,995 to 15,105,097 | 3 |
| 64 | 16 | hll | mon | 7.2 to 9.5 | 0 | 105,429,111 to 139,422,871 | 3 |
| 64 | 256 | hll | mon | 0.2 to 0.6 | 0 | 1,731,923,831 to 4,250,065,602 | 3 |
| 256 | 1 | roomStats | inv | 1,441.6 to 1,728.5 | 1.984 | 578,543 to 693,692 | 3 |
| 256 | 16 | roomStats | inv | 866.6 to 1,088.6 | 1.547 | 918,605 to 1,153,894 | 3 |
| 256 | 256 | roomStats | inv | 90.6 to 119.5 | 0.234 | 8,369,406 to 11,036,155 | 3 |
| 256 | 1 | hist | inv | 246.2 to 304.1 | 1.565 | 3,288,145 to 4,061,275 | 3 |
| 256 | 16 | hist | inv | 87.8 to 94.3 | 0.477 | 10,609,042 to 11,387,718 | 3 |
| 256 | 256 | hist | inv | 6.1 to 13.1 | 0.04 | 76,174,890 to 164,814,049 | 3 |
| 256 | 1 | distinct | inv | 861.5 to 1,423.2 | 0.973 | 702,655 to 1,160,735 | 3 |
| 256 | 16 | distinct | inv | 297.9 to 349.8 | 0.063 | 2,859,152 to 3,357,143 | 3 |
| 256 | 256 | distinct | inv | 109.8 to 140.4 | 0.004 | 7,123,707 to 9,110,417 | 3 |
| 256 | 1 | maxByRoom | mon | 49,993.3 to 54,114.8 | 1.679 | 18,479 to 20,003 | 3 |
| 256 | 16 | maxByRoom | mon | 30,635 to 39,886 | 1.25 | 25,071 to 32,642 | 3 |
| 256 | 256 | maxByRoom | mon | 5,752 to 6,856.5 | 0.207 | 145,847 to 173,853 | 3 |
| 256 | 1 | top | mon | 38,317.7 to 40,515.5 | 0.258 | 24,682 to 26,098 | 3 |
| 256 | 16 | top | mon | 7,091.9 to 7,883.3 | 0.052 | 126,851 to 141,007 | 3 |
| 256 | 256 | top | mon | 581.2 to 632.6 | 0.004 | 1,580,860 to 1,720,521 | 3 |
| 256 | 1 | hll | mon | 60.2 to 80.9 | 0 | 12,362,223 to 16,606,393 | 3 |
| 256 | 16 | hll | mon | 10.1 to 11.2 | 0 | 89,330,403 to 99,394,556 | 3 |
| 256 | 256 | hll | mon | 0.6 to 0.9 | 0 | 1,098,049,712 to 1,627,819,395 | 3 |

## fero's checks: the self-check at build (200 trials over 64 rows) and the audit (pieces again from the rows)

| fold | self-check ms | audit ns a row (25,000 rows) | audit ms at 250,000 rows |
|---|---|---|---|
| roomStats | 3.047 to 3.211 | 137 to 188 | 34.9 to 39.4 |
| hist | 0.659 to 0.985 | 94 to 97 | 15.1 to 19.5 |
| distinct | 9.057 to 9.251 | 418 to 437 | 77.1 to 81 |
| maxByRoom | 0.844 to 1.03 | 1,252 to 2,000 | 451.5 to 486.8 |
| top | 10.946 to 15.781 | 2,421 to 2,623 | 716.5 to 848 |
| hll | 14.641 to 19.393 | 1,742 to 2,390 | 542.3 to 590.8 |
