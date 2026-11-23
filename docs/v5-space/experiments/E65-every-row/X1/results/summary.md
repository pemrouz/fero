# E-65 X1: results

Printed by `node src/summarize.mjs` from the JSON lines in this folder. A timed cell is the median of the runs and, in brackets, the lowest and highest run.

## Seeded runs: the split stores and the compact stores

| part | form | S | G | domain | planted | seeds | failed | checks | slot moves | records held (B1) | resends dropped (B2) | rows moved (B4) | float sum off exact | first failure |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| split | one | - | 4 | int | none | 1000 | 0 | 81,000 | 13178 | 6535 | 148475 | - | - | - |
| split | blocks | 8 | 4 | int | none | 1000 | 0 | 81,000 | 13178 | 6535 | 148475 | - | - | - |
| split | groups | - | 4 | int | none | 1000 | 0 | 81,000 | 13178 | 6535 | 148475 | 104017 | - | - |
| split | blocks | 32 | 8 | int | none | 1000 | 0 | 81,000 | 13110 | 2564 | 145609 | - | - | - |
| split | one | - | 4 | float | none | 1000 | 0 | 81,000 | 13178 | 6535 | 148475 | - | 71227 of 81000 | - |
| split | blocks | 8 | 4 | float | none | 1000 | 0 | 81,000 | 13178 | 6535 | 148475 | - | 42090 of 81000 | - |
| split | blocks | 8 | 4 | int | noorder | 1000 | 794 | 46,778 | 7573 | 0 | 79436 | - | - | seed 1: count 217 vs 219 |
| split | blocks | 8 | 4 | int | nodup | 1000 | 948 | 31,145 | 5088 | 1513 | 0 | - | - | seed 1: count 185 vs 184 |
| split | blocks | 8 | 4 | int | route | 1000 | 1000 | 2,112 | 352 | 1 | 800 | - | - | seed 1: get k4745: u vs {"cents":2118,"paid":T,"score":792,"title":"t991653"," |
| split | blocks | 8 | 4 | int | topshort | 1000 | 62 | 77,403 | 12586 | 6236 | 141269 | - | - | seed 1: top [981,953,950,932,925,919,909,909,906,892] vs [981,953,950,932,925, |
| split | blocks | 8 | 4 | int | medmed | 1000 | 1000 | 1,132 | 195 | 0 | 215 | - | - | seed 1: median 548 vs 541 |
| split | blocks | 2 | 4 | int | topshort | 1000 | 1000 | 1,417 | 242 | 2 | 379 | - | - | seed 1: top [981,972,925,919,909,906,802,792,689,474] vs [981,972,925,919,909, |
| split | groups | - | 4 | int | nomigrate | 1000 | 1000 | 17,727 | 2966 | 460 | 24918 | - | - | seed 1: count 217 vs 216 |
| compact | arena | - | - | dirty | none | 1000 | 0 | 600,000 | - | - | - | - | - | - |
| compact | column | - | - | dirty | none | 1000 | 0 | 600,000 | - | - | - | - | - | - |
| compact | kvdisk | - | - | dirty | none | 1000 | 0 | 600,000 | - | - | - | - | - | - |
| compact | arena | - | - | dirty | tombstop | 1000 | 1000 | 70,961 | - | - | - | - | - | seed 1: get k346: u vs {"at":6575,"cents":1163,"paid":F,"qty":6794.44,"score": |
| compact | arena | - | - | dirty | compactaddr | 1000 | 1000 | 70,703 | - | - | - | - | - | seed 1: Unexpected non-whitespace character after JSON at position 5 (line 1 c |
| compact | column | - | - | dirty | tombstop | 1000 | 1000 | 71,039 | - | - | - | - | - | seed 1: get k346: u vs {"at":6575,"cents":1163,"paid":F,"qty":6794.44,"score": |
| compact | column | - | - | dirty | presence | 1000 | 1000 | 8,278 | - | - | - | - | - | seed 1: get k391: {"at":2253,"cents":8795,"qty":402.75,"score":8041,"title":"t |
| compact | column | - | - | dirty | nooverflow | 1000 | 1000 | 1,071 | - | - | - | - | - | seed 1: get k553: {"at":3883,"paid":F,"qty":6575,"score":NaN,"title":"title fo |
| compact | kvdisk | - | - | dirty | tombstop | 1000 | 1000 | 70,961 | - | - | - | - | - | seed 1: get k346: u vs {"at":6575,"cents":1163,"paid":F,"qty":6794.44,"score": |

load average (1 min) at the start of each process: median 1.08, range 1.04-10.87, n=22

## Seeded runs: the memory-budget guard (budget 32 MB of heap, heap limit 128 MB)

| policy | seeds | failed | why | live heap at the warning, % of budget (min, p50, max) | live heap at the refusal (min, p50, max) | guard check ns | largest forced collection ms |
|---|---|---|---|---|---|---|---|
| heapnow | 100 | 100 | warned at N % of the budget: 100 | 33.5, 50, 64.3 | 54.5, 67.8, 83.9 | 5025 | - |
| model | 100 | 98 | live heap N % of the budget, not refused: 11; warned at N % of the budget: 71; refused only at N %: 16 | 76.8, 93.1, 110.8 | 91.7, 104.9, 112.6 | 722 | - |
| first | 100 | 93 | live heap N % of the budget, not refused: 16; refused only at N %: 18; warned at N % of the budget: 59 | 77.8, 92.8, 107.2 | 96.6, 103.2, 112.6 | 1008 | - |
| aftergc | 100 | 32 | warned at N % of the budget: 29; refused at N %: 2; refused only at N %: 1 | 62.8, 73, 82.5 | 77.9, 88.8, 101 | 1334 | - |
| scaled | 100 | 99 | warned at N % of the budget: 97; refused at N %: 2 | 54.8, 65.4, 72.1 | 62.9, 77.3, 90.1 | 1605 | - |
| confirm | 100 | 0 | - | 80, 80.5, 84.2 | 90, 91, 96.2 | 2192 | 168.9 |

The model fitted at start (heap bytes a row = a x JSON bytes + b): a = 0.97, b = 169; points 122 B of JSON -> 287 B of heap, 2037 B of JSON -> 2147 B of heap.
load average (1 min) at the start of each process: median 8.12, range 1.98-9.86, n=6

## Does data free a dropped source? (checked, a probe, three rounds of 1e5 small rows a way)

| way | heap MB at start | heap MB after each round | kept MB a round |
|---|---|---|---|
| drop | 8.8 | 27.1, 45.3, 63.5 | 18.2 |
| dispose | 63.5 | 87, 110.5, 131.8 | 22.8 |
| clear | 131.8 | 144.9, 131.9, 131.9 | 0 |

## Bytes a row at 1e6 rows (heavy lock; runs agree closely)

| form | heap after load | off-heap after load | RSS after load | heap after 1e6 more writes | off-heap after | RSS after | file | runs |
|---|---|---|---|---|---|---|---|---|
| one | 298 (298-298) | 0.00 (0.00-0.00) | 335 (335-341) | 296 (296-296) | 2.00 (2.00-2.00) | 701 (698-703) | 0.00 (0.00-0.00) | 3 |
| blocks16 | 296 (296-296) | 0.00 (0.00-0.00) | 332 (328-335) | 295 (295-295) | 2.00 (2.00-2.00) | 759 (751-759) | 0.00 (0.00-0.00) | 3 |
| blocks64 | 300 (300-300) | 0.00 (0.00-0.00) | 361 (359-365) | 300 (300-300) | 2.00 (2.00-2.00) | 767 (764-770) | 0.00 (0.00-0.00) | 3 |
| proj | 154 (154-154) | 0.00 (0.00-0.00) | 199 (192-204) | 156 (156-156) | 2.00 (2.00-2.00) | 543 (539-551) | 0.00 (0.00-0.00) | 3 |
| arena | 0.10 (0.10-0.10) | 373 (373-373) | 229 (229-229) | -0.10 (-0.10--0.10) | 375 (375-375) | 313 (301-313) | 0.00 (0.00-0.00) | 3 |
| kvdisk | 0.10 (0.10-0.10) | 107 (107-107) | 94.1 (93.7-94.2) | 4.30 (4.30-4.30) | 109 (109-109) | 191 (191-191) | 254 (254-254) | 3 |
| column | 7.90 (7.90-7.90) | 248 (248-248) | 156 (155-157) | 12.1 (12.1-12.1) | 250 (250-250) | 298 (296-300) | 0.00 (0.00-0.00) | 3 |
| sqlite | 0.10 (0.10-0.10) | 0.00 (0.00-0.00) | 105 (105-105) | 3.60 (3.60-3.60) | 2.00 (2.00-2.00) | 162 (160-164) | 163 (163-163) | 3 |

## Fold: ns a record at 1e6 rows, the write mix in lanes of 256 (timing lock)

| form | live views | ns a record | records a second | runs |
|---|---|---|---|---|
| one | no | 1,853 (1,845-1,990) | 539,821 (502,604-542,045) | 3 |
| blocks16 | no | 1,836 (1,670-1,904) | 544,668 (525,201-598,890) | 3 |
| blocks64 | no | 2,055 (1,968-2,206) | 486,670 (453,225-508,173) | 3 |
| proj | no | 1,881 (1,611-1,955) | 531,667 (511,518-620,640) | 3 |
| arena | no | 2,439 (2,193-2,939) | 410,075 (340,260-455,970) | 3 |
| kvdisk | no | 2,984 (2,735-3,166) | 335,148 (315,880-365,626) | 3 |
| column | no | 1,147 (1,132-1,374) | 871,868 (727,591-883,736) | 3 |
| sqlite | no | 7,685 (6,638-8,068) | 130,132 (123,953-150,644) | 3 |
| one | yes | 3,526,245 (3,302,970-4,276,939) | 284 (234-303) | 3 |
| blocks16 | yes | 45,663 (45,339-47,232) | 21,900 (21,172-22,056) | 3 |
| proj | yes | 3,569,555 (3,429,656-3,937,985) | 280 (254-292) | 3 |
| column | yes | 5,540 (5,113-6,632) | 180,492 (150,797-195,585) | 3 |

## A live median: ns a record (fold and median), and one read of the median

| median form | rows | ns a record | read ns | runs |
|---|---|---|---|---|
| none | 100,000 | 1,137 (1,079-1,341) | 1,053 (773-1,249) | 3 |
| none | 1,000,000 | 1,990 (1,912-2,046) | 801 (743-822) | 3 |
| data | 100,000 | 13,259 (12,366-13,391) | 3,202 (2,606-3,487) | 3 |
| data | 1,000,000 | 184,351 (150,110-193,395) | 4,382 (2,957-4,818) | 3 |
| data16 | 100,000 | 2,663 (2,593-2,668) | 4,927 (4,616-4,967) | 3 |
| data16 | 1,000,000 | 11,693 (10,395-11,751) | 5,013 (4,726-5,179) | 3 |
| sorted | 100,000 | 1,617 (1,479-1,696) | 6,078 (5,930-6,479) | 3 |
| sorted | 1,000,000 | 2,817 (2,494-3,565) | 17,724 (14,593-17,761) | 3 |

## Reads over every row at 1e6 rows

| form | get ns | one field, ns a row | every row as an object, ns a row | exact median once, ms | column sum ns a row | SQL sum ns a row | index median ms | runs |
|---|---|---|---|---|---|---|---|---|
| one | 1,017 (834-1,046) | 79.2 (78.9-90.0) | 79.3 (77.1-82.8) | 171 (170-185) | - | - | - | 3 |
| blocks16 | 1,426 (1,388-1,440) | 73.2 (72.6-76.5) | 58.4 (41.5-65.6) | 161 (154-163) | - | - | - | 3 |
| proj | 871 (805-1,306) | 58.6 (55.9-65.9) | 60.7 (54.5-73.3) | 155 (151-166) | - | - | - | 3 |
| arena | 1,939 (1,910-1,978) | 1,477 (1,370-1,518) | 1,908 (1,697-1,929) | 1,441 (1,400-1,629) | - | - | - | 3 |
| kvdisk | 2,717 (2,308-2,761) | 2,135 (2,084-2,145) | 2,500 (2,332-2,505) | 2,185 (2,020-2,192) | - | - | - | 3 |
| column | 2,728 (2,532-3,391) | 11.1 (10.8-17.8) | 629 (605-634) | 106 (105-107) | 7.79 (7.15-8.55) | - | - | 3 |
| sqlite | 7,902 (7,725-7,974) | 1,139 (1,132-1,144) | 2,241 (2,062-2,379) | 1,195 (1,173-1,274) | - | 376 (376-386) | - | 3 |
| sqlite-ix | 7,573 (6,885-8,110) | 1,194 (1,074-1,238) | 2,164 (2,134-2,201) | 1,196 (1,191-1,254) | - | 380 (379-412) | 1,828 (1,749-1,877) | 3 |

## GC pauses: loading 5e6 rows, then 10 s of 50,000 writes a second (ms)

| form | load s | heap MB | off-heap MB | load: longest pause | load: longest major | writes: longest pause | writes: longest major | loop delay p99 | loop delay max | achieved/s | runs |
|---|---|---|---|---|---|---|---|---|---|---|---|
| column | 9.90 (9.70-10.0) | 129 (110-137) | 1,166 (1,166-1,166) | 11.0 (9.50-14.3) | 11.0 (9.50-14.3) | 27.7 (23.0-40.7) | 27.7 (23.0-40.7) | 1.50 (1.50-1.50) | 5.40 (4.80-14.2) | 50,004 (50,001-50,006) | 3 |
| arena | 8.00 (7.80-8.10) | 123 (121-123) | 2,098 (2,098-2,098) | 5.60 (5.40-6.10) | 5.60 (5.40-6.10) | 28.1 (24.3-42.6) | 28.1 (24.3-42.6) | 1.80 (1.70-1.90) | 6.40 (5.10-49.1) | 50,003 (50,001-50,017) | 3 |
| one | 8.90 (8.80-9.50) | 1,658 (1,658-1,658) | 18.0 (18.0-18.0) | 1,257 (1,252-1,341) | 1,257 (1,252-1,341) | 26.8 (24.7-48.3) | 0.00 (0.00-0.00) | 1.50 (1.50-1.70) | 24.4 (23.3-55.0) | 50,001 (50,000-50,002) | 3 |
| blocks16 | 8.90 (8.60-9.40) | 1,647 (1,645-1,651) | 18.0 (18.0-18.0) | 1,041 (881-1,062) | 1,041 (881-1,062) | 27.0 (22.6-29.2) | 0.00 (0.00-0.00) | 1.60 (1.60-1.70) | 15.1 (12.2-15.3) | 50,005 (50,005-50,006) | 3 |

Reading this process's memory (ns a call): v8.getHeapStatistics() 465 (450-648); process.memoryUsage() 2,452 (2,410-4,013); process.memoryUsage.rss() 2,006 (1,961-3,204).

load average (1 min) at the start of each process: median 1.34, range 0.99-2.38, n=101

Failed processes: node --experimental-strip-types --no-warnings --expose-gc --max-old-space-size=3500 src/bench.mjs gc --form=one --rows=5000000 --rate=50000 --secs=10; node --experimental-strip-types --no-warnings --expose-gc --max-old-space-size=3500 src/bench.mjs gc --form=blocks16 --rows=5000000 --rate=50000 --secs=10. (The two GC lines of run 1 failed from a bench bug: the write pool wrapped and replayed a field write on a row deleted since, which data refuses. The pool was fixed and both lines were run again as run 1; their command lines carry a note.)

## Worker threads: the fold of 1e6 records over 1e6 rows, split by slot (timing lock)

| workers | live views (count, sum, exact median kept on the main thread) | records a second, all workers | main thread busy % | each worker busy % | kept median = a fresh sort at the end | runs |
|---|---|---|---|---|---|---|
| 0 (main folds) | no | 287,539 (274,940-296,871) | 100 (100-100) | - | - | 3 |
| 0 (main folds) | yes | 249,625 (238,878-258,026) | 100 (100-100) | - | - | 3 |
| 1 | no | 288,101 (269,413-300,266) | 0.40 (0.40-0.40) | 100; 100; 100 | - | 3 |
| 1 | yes | 264,943 (243,716-274,748) | 12.1 (12.0-13.0) | 101; 101; 101 | 3 of 3 | 3 |
| 2 | no | 566,256 (515,020-652,988) | 0.70 (0.60-0.80) | 97/100; 100/99; 93/100 | - | 3 |
| 2 | yes | 566,977 (424,343-588,075) | 21.7 (21.4-24.8) | 97/105; 104/101; 98/101 | 3 of 3 | 3 |
| 3 | no | 784,137 (708,554-820,941) | 0.90 (0.90-1.00) | 99/88/75; 100/79/83; 100/80/87 | - | 3 |
| 3 | yes | 737,105 (634,243-746,092) | 32.7 (30.8-33.1) | 101/86/82; 101/88/82; 101/85/80 | 3 of 3 | 3 |

## Worker threads: reads over every row from the main thread (1e6 rows)

| workers | get, one at a time (round trip us) | get, 64 in flight (ns each) | every row as pages decoded here (ns a row) | one column, then an exact median (ms) | runs |
|---|---|---|---|---|---|
| 1 | 45.2 (45.2-45.9) | 8,983 (8,911-9,561) | 2,356 (2,203-2,465) | 148 (146-152) | 3 |
| 2 | 49.9 (47.1-51.8) | 11,502 (10,823-14,023) | 2,333 (2,238-2,361) | 132 (122-142) | 3 |
| 3 | 48.6 (47.2-51.2) | 12,371 (12,108-12,700) | 2,298 (2,221-2,311) | 122 (118-127) | 3 |

load average (1 min) at the start of each process: median 1.25, range 0.91-1.89, n=33
