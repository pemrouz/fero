# E-64 O3: results

## Seeded runs: long runs (one seed, every frame checked)

| groups | early | commits | checks | mismatches | moves (slots) | grows / shrinks | host failovers | outages | duplicates | merged runs | combiner rebuilds | pictures taken | frames dropped (S2) | torn commits (states seen) | seconds |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 16 | no | 100,000 | 645,436 | 0 | 2,044 (26,082) | 0 / 0 | 110 | 53 | 128 | 12,310 | 40 | 41,972 | 31,819 | 13 of 3,512 (45) | 254.2 |
| elastic | no | 100,000 | 754,930 | 0 | 2,042 (81,407) | 762 / 748 | 125 | 45 | 132 | 19,329 | 37 | 45,792 | 76,014 | 530 of 4,546 (2,638) | 302.7 |
| 4 | no | 100,000 | 642,272 | 0 | 2,036 (31,354) | 0 / 0 | 119 | 44 | 126 | 13,829 | 31 | 33,928 | 58,518 | 22 of 4,651 (43) | 310.6 |
| elastic | yes | 100,000 | 738,886 | 0 | 1,974 (78,300) | 728 / 714 | 144 | 63 | 137 | 19,060 | 38 | 46,361 | 73,375 | 552 of 4,567 (2,544) | 301 |

## Seeded runs: 1,000 short seeds each (400 commits, 300 keys)

| groups | code | seeds failed | checks | mismatches | first failure |
|---|---|---|---|---|---|
| 4 | real | 0 of 1000 | 2,780,560 | 0 | — |
| 4 | variant: early | 0 of 1000 | 2,778,936 | 0 | — |
| 4 | planted: nor1 | 240 of 1000 | 2,780,952 | 57,113 | `positions never go back: slot 420: 2 -> 1` |
| 4 | planted: nopicture | 404 of 1000 | 2,227,350 | 88,359 | `by(room) count: M{"n1":5,"n2":1,"n4":1,"n5":3,"s2":1,"s3":1,"s4":1,"s5` |
| 4 | planted: coalescedrop | 989 of 1000 | 2,780,560 | 940,527 | `length(): 14 vs 15` |
| 4 | planted: mergepic | 417 of 1000 | 2,780,560 | 206,063 | `by(room) count: M{"n1":3,"n3":2,"n4":1,"n5":2,"s1":2,"sr0":1,"sr1":1,"` |
| 4 | planted: extmerged | 1000 of 1000 | 2,780,560 | 359,305 | `by(room) max: M{"n5":80,"s1":Infinity,"s2":2,"sr0":69,"sr1":63,"sr10":` |
| 4 | planted: ties | 1000 of 1000 | 2,780,560 | 247,236 | `za(points, 10) key sequence: ["k71","k163","k227","k128","k74","k298",` |
| 4 | planted: rounded | 1000 of 1000 | 2,780,560 | 471,521 | `sum(points) exact: NaN vs 1198.78` |
| elastic | real | 0 of 1000 | 3,533,571 | 0 | — |
| elastic | variant: early | 2 of 1000 | 3,544,438 | 3 | `positions never go back: slot 812: 2 -> 1` |
| 4 | planted: pergroup | 973 of 1000 | 3,212,369 | 848,910 | `length(): 69 vs 70` |
| elastic | planted: nor1 | 824 of 1000 | 3,539,215 | 340,174 | `positions never go back: slot 883: 2 -> 1` |
| elastic | planted: nopicture | 403 of 1000 | 2,045,707 | 103,448 | `drained: the cut is every slot's head: some slot behind` |
| elastic | planted: mergepic | 860 of 1000 | 3,533,571 | 837,972 | `by(room) count: M{"n1":2,"n2":3,"n4":3,"s1":3,"s4":3,"sr0":1,"sr10":2,` |
| elastic | planted: coalescedrop | 989 of 1000 | 3,533,571 | 1,274,248 | `length(): 13 vs 14` |
| elastic | planted: ties | 1000 of 1000 | 3,533,571 | 307,490 | `za(points, 10) key sequence: ["k146","k84","k127","k183","k136","k216"` |
| elastic | planted: extmerged | 1000 of 1000 | 3,533,571 | 455,191 | `by(room) max: M{"n2":30,"s2":77,"sr13":58,"sr14":59,"sr24":24,"sr33":6` |
| elastic | planted: rounded | 1000 of 1000 | 3,533,571 | 586,461 | `sum(points) exact: 1961.4299999999998 vs 1961.43` |
| elastic | planted: pergroup | 999 of 1000 | 5,201,146 | 2,806,883 | `length(): 73 vs 72` |

## Host: keeping per-slot partials, per write (S = 4,096; three runs, min to max)

| view | N | B | rows a slot | ns a write | frame entries a write | cells a write |
|---|---|---|---|---|---|---|
| add | 100,000 | 16 | 24 | 2,319 to 3,315 | 1 | 2.0334 |
| add | 100,000 | 1000 | 24 | 2,084 to 3,334 | 1 | 2.0366 |
| ext | 100,000 | 16 | 24 | 2,920 to 3,736 | 1 | 2.6284 |
| ext | 100,000 | 1000 | 24 | 3,669 to 4,504 | 1 | 2.9767 |
| win | 100,000 | 16 | 24 | 3,843 to 4,912 | 0.5471 | 0.5471 |
| gt | 100,000 | 16 | 24 | 438 to 533 | 0.7271 | 0.7271 |
| add | 1,000,000 | 16 | 244 | 2,559 to 3,065 | 1 | 2.0203 |
| add | 1,000,000 | 1000 | 244 | 3,230 to 3,757 | 1 | 2.0217 |
| ext | 1,000,000 | 16 | 244 | 2,652 to 3,357 | 1 | 2.065 |
| ext | 1,000,000 | 1000 | 244 | 4,610 to 7,308 | 1 | 2.3711 |
| win | 1,000,000 | 16 | 244 | 1,674 to 1,914 | 0.029 | 0.029 |
| gt | 1,000,000 | 16 | 244 | 683 to 852 | 0.5876 | 0.5876 |

## Combiner: applying those frames (three runs, min to max)

| view | N | B | ns a frame entry | ns a cell | ns a source write | window candidates |
|---|---|---|---|---|---|---|
| add | 100,000 | 16 | 2,024 to 2,459 | 967 to 1,174 | 2,024 to 2,459 | 0 |
| add | 100,000 | 1000 | 1,936 to 2,938 | 922 to 1,399 | 1,936 to 2,938 | 0 |
| ext | 100,000 | 16 | 1,875 to 2,895 | 677 to 1,045 | 1,875 to 2,895 | 0 |
| ext | 100,000 | 1000 | 2,885 to 3,756 | 905 to 1,178 | 2,885 to 3,756 | 0 |
| win | 100,000 | 16 | 11,548 to 13,432 | 11,548 to 13,432 | 6,928 to 8,058 | 40,957 |
| gt | 100,000 | 16 | 279 to 393 | 279 to 393 | 209 to 295 | 0 |
| add | 1,000,000 | 16 | 2,572 to 3,291 | 1,229 to 1,573 | 2,572 to 3,291 | 0 |
| add | 1,000,000 | 1000 | 3,726 to 4,032 | 1,775 to 1,920 | 3,726 to 4,032 | 0 |
| ext | 1,000,000 | 16 | 2,783 to 3,378 | 1,256 to 1,525 | 2,783 to 3,378 | 0 |
| ext | 1,000,000 | 1000 | 4,083 to 4,521 | 1,314 to 1,455 | 4,083 to 4,521 | 0 |
| win | 1,000,000 | 16 | 11,575 to 15,378 | 11,575 to 15,378 | 926 to 1,230 | 40,960 |
| gt | 1,000,000 | 16 | 1,142 to 1,485 | 1,142 to 1,485 | 857 to 1,115 | 0 |

## The delta form, for comparison: counts and exact sums per bucket (three runs, min to max)

| N | B | copy: ns a write | combiner: ns a frame | frame JSON bytes |
|---|---|---|---|---|
| 100,000 | 16 | 228 to 385 | 473 to 679 | 40 |
| 100,000 | 1000 | 248 to 328 | 560 to 602 | 39 |
| 1,000,000 | 16 | 325 to 524 | 496 to 768 | 37 |
| 1,000,000 | 1000 | 358 to 600 | 685 to 925 | 42 |

## Windows: frames a write, partials by slot against by group (counts)

| N | K | scores | by slot (4,096) | G = 4 | G = 16 | G = 64 | G = 256 |
|---|---|---|---|---|---|---|---|
| 100,000 | 10 | uniform | 0.63404 | 0.00094 | 0.00331 | 0.01329 | 0.05113 |
| 100,000 | 10 | rising | 0.57139 | 0.2198 | 0.22254 | 0.22716 | 0.24416 |
| 100,000 | 100 | uniform | 1 | 0.008 | 0.03236 | 0.12455 | 0.44743 |
| 100,000 | 100 | rising | 1 | 0.20955 | 0.21987 | 0.25992 | 0.4288 |
| 1,000,000 | 10 | uniform | 0.0812 | 0.00007 | 0.00036 | 0.00123 | 0.00524 |
| 1,000,000 | 10 | rising | 0.19177 | 0.1558 | 0.15635 | 0.15674 | 0.15843 |
| 1,000,000 | 100 | uniform | 0.64949 | 0.00069 | 0.00311 | 0.01253 | 0.05031 |
| 1,000,000 | 100 | rising | 0.53021 | 0.17308 | 0.17421 | 0.17832 | 0.19595 |

## A partials resource: partial-row writes per source write, frames merged per window (counts)

| keys | writes a second | window | by slot: row writes a write | by slot: a second | by group (G = 16): a write | by group: a second |
|---|---|---|---|---|---|---|
| uniform | 10,000 | 0 ms | 1 | 10,000 | 1 | 10,000 |
| uniform | 10,000 | 10 ms | 0.9876 | 9,876 | 0.15971 | 1,597 |
| uniform | 10,000 | 100 ms | 0.8872 | 8,872 | 0.016 | 160 |
| uniform | 10,000 | 1000 ms | 0.3733 | 3,733 | 0.0016 | 16 |
| uniform | 50,000 | 0 ms | 1 | 50,000 | 1 | 50,000 |
| uniform | 50,000 | 10 ms | 0.9411 | 47,053 | 0.032 | 1,600 |
| uniform | 50,000 | 100 ms | 0.5769 | 28,845 | 0.0032 | 160 |
| uniform | 50,000 | 1000 ms | 0.0819 | 4,096 | 0.00032 | 16 |
| uniform | 200,000 | 0 ms | 1 | 200,000 | 1 | 200,000 |
| uniform | 200,000 | 10 ms | 0.7905 | 158,107 | 0.008 | 1,600 |
| uniform | 200,000 | 100 ms | 0.2032 | 40,638 | 0.0008 | 160 |
| uniform | 200,000 | 1000 ms | 0.0205 | 4,096 | 0.00008 | 16 |
| zipf | 10,000 | 0 ms | 1 | 10,000 | 1 | 10,000 |
| zipf | 10,000 | 10 ms | 0.8521 | 8,521 | 0.1593 | 1,593 |
| zipf | 10,000 | 100 ms | 0.6533 | 6,533 | 0.016 | 160 |
| zipf | 10,000 | 1000 ms | 0.3039 | 3,039 | 0.0016 | 16 |
| zipf | 50,000 | 0 ms | 1 | 50,000 | 1 | 50,000 |
| zipf | 50,000 | 10 ms | 0.7231 | 36,154 | 0.032 | 1,600 |
| zipf | 50,000 | 100 ms | 0.426 | 21,299 | 0.0032 | 160 |
| zipf | 50,000 | 1000 ms | 0.0816 | 4,078 | 0.00032 | 16 |
| zipf | 200,000 | 0 ms | 1 | 200,000 | 1 | 200,000 |
| zipf | 200,000 | 10 ms | 0.5673 | 113,455 | 0.008 | 1,600 |
| zipf | 200,000 | 100 ms | 0.1875 | 37,492 | 0.0008 | 160 |
| zipf | 200,000 | 1000 ms | 0.0205 | 4,096 | 0.00008 | 16 |

## Combiner memory (heap after a full collection; three runs, min to max)

| what | form | partials | B or K | cells or rows | bytes | bytes a cell or row |
|---|---|---|---|---|---|---|
| count+exact sum per bucket | slot | 4,096 | 1 | 4,096 | 1,696,448 | 414 |
| count+exact sum per bucket | group16 | 16 | 1 | 16 | 5,536 to 6,456 | 346 to 404 |
| count+exact sum per bucket | group256 | 256 | 1 | 256 | 102,944 | 402 |
| count+exact sum per bucket | merged | 0 | 1 | 0 | 80 | 80 |
| max per bucket | slot | 4,096 | 1 | 4,096 | 115,928 | 28 |
| count+exact sum per bucket | slot | 4,096 | 16 | 65,536 | 15,802,608 | 241 |
| count+exact sum per bucket | group16 | 16 | 16 | 256 | 63,280 | 247 |
| count+exact sum per bucket | group256 | 256 | 16 | 4,096 | 989,544 | 242 |
| count+exact sum per bucket | merged | 0 | 16 | 0 | 5,456 to 19,408 | 341 to 1,213 |
| max per bucket | slot | 4,096 | 16 | 65,536 | 1,723,896 to 1,825,680 | 26 to 28 |
| count+exact sum per bucket | slot | 4,096 | 100 | 409,600 | 100,134,464 to 100,180,256 | 244 to 245 |
| count+exact sum per bucket | group16 | 16 | 100 | 1,600 | 362,608 to 421,224 | 227 to 263 |
| count+exact sum per bucket | group256 | 256 | 100 | 25,600 | 6,283,072 to 6,284,424 | 245 |
| count+exact sum per bucket | merged | 0 | 100 | 0 | 36,800 | 368 |
| max per bucket | slot | 4,096 | 100 | 409,600 | 11,493,056 to 11,494,120 | 28 |
| count+exact sum per bucket | slot | 4,096 | 1000 | 4,096,000 | 970,104,544 to 970,106,656 | 237 |
| count+exact sum per bucket | group16 | 16 | 1000 | 16,000 | 4,151,688 to 4,154,352 | 259 to 260 |
| count+exact sum per bucket | group256 | 256 | 1000 | 256,000 | 60,789,872 to 60,798,208 | 237 |
| count+exact sum per bucket | merged | 0 | 1000 | 0 | 297,024 to 305,304 | 297 to 305 |
| max per bucket | slot | 4,096 | 1000 | 4,096,000 | 114,082,672 to 114,085,744 | 28 |
| window candidates | slot/group | 4,096 | 10 | 40,960 | 5,796,240 to 5,796,560 | 142 |
| window candidates | slot/group | 16 | 10 | 160 | below the heap's noise | — |
| window candidates | slot/group | 256 | 10 | 2,560 | 346,264 to 348,000 | 135 to 136 |
| window candidates | slot/group | 4,096 | 100 | 409,600 | 30,817,896 to 30,823,240 | 75 |
| window candidates | slot/group | 16 | 100 | 1,600 | 214,648 to 216,384 | 134 to 135 |
| window candidates | slot/group | 256 | 100 | 25,600 | 3,306,904 | 129 |

## Bytes (JSON, a stand-in for the codec; counts)

| N | B | by-bucket cells | sum | max | top 10 | filter | entries a write | a picture of one slot |
|---|---|---|---|---|---|---|---|---|
| 100,000 | 16 | 110.3 | 89.5 | 17.4 | 200.8 | 33.3 | 1 | 657 |
| 1,000,000 | 16 | 116.1 | 92.7 | 3.2 | 27.4 | 34.5 | 1 | 1,887 |
| 100,000 | 1000 | 106.1 | 89.5 | 29.7 | 202.2 | 33.5 | 1 | 989 |
| 1,000,000 | 1000 | 107.8 | 92.7 | 27.6 | 27.4 | 34.9 | 1 | 7,289 |

1-minute load average when each timed process was queued: 1.17 to 3.27.
