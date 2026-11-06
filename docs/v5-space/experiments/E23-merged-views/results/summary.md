### Run A, condensed: mismatches / checks, summed over every configuration of the domain (G = 1, 4, 16, elastic; mixes moves and failover)

| check | int | float | dirty |
|---|---:|---:|---:|
| avg L=Q | 0 / 800370 | **794951** / 800334 (99.3%; 8/8 runs) | **101** / 800382 (0.013%; 3/8 runs) |
| avg M=L | **192** / 800370 (0.024%; 4/8 runs) | **689952** / 800334 (86.2%; 7/8 runs) | **27** / 800382 (0.003%; 5/8 runs) |
| avg M=Q | **192** / 800370 (0.024%; 4/8 runs) | **778070** / 800334 (97.2%; 8/8 runs) | **128** / 800382 (0.016%; 7/8 runs) |
| avgC M=Q | 0 / 800370 | 0 / 800334 | 0 / 800382 |
| countBy L=Q | **238** / 1371920 (0.017%; 8/8 runs) | **233** / 1366082 (0.017%; 8/8 runs) | **268** / 1390933 (0.019%; 8/8 runs) |
| countBy M=L | 0 / 1371920 | 0 / 1366082 | **3** / 1390933 (0.000%; 1/8 runs) |
| countBy M=L buckets | 0 / 800370 | 0 / 800334 | **328** / 800382 (0.041%; 1/8 runs) |
| countBy M=Q | **238** / 1371920 (0.017%; 8/8 runs) | **233** / 1366082 (0.017%; 8/8 runs) | **265** / 1390933 (0.019%; 8/8 runs) |
| countByC M=Q | 0 / 1720160 | 0 / 1713966 | 0 / 1774384 |
| distinct L=Q | 0 / 557665 | 0 / 554778 | **27183** / 617186 (4.4%; 8/8 runs) |
| distinct M=L | 0 / 557665 | 0 / 554778 | **20336** / 617186 (3.3%; 6/8 runs) |
| distinct M=L buckets | 0 / 11158 | 0 / 11100 | 0 / 11227 |
| distinct M=Q | 0 / 557665 | 0 / 554778 | **26635** / 617186 (4.3%; 8/8 runs) |
| distinctC M=Q | 0 / 1720160 | 0 / 1713966 | 0 / 1774384 |
| every L=Q | 0 / 800370 | 0 / 800334 | 0 / 800382 |
| every M=L | 0 / 800370 | 0 / 800334 | 0 / 800382 |
| every M=Q | 0 / 800370 | 0 / 800334 | 0 / 800382 |
| filter L=Q | 0 / 8321823 | 0 / 8175699 | 0 / 8374376 |
| filter M=L | 0 / 8321823 | 0 / 8175699 | 0 / 8374376 |
| filter M=L count | 0 / 800370 | 0 / 800334 | 0 / 800382 |
| filter M=Q | 0 / 8321823 | 0 / 8175699 | 0 / 8374376 |
| group L=Q | 0 / 1371904 | 0 / 1366075 | 0 / 1390919 |
| group M=L | 0 / 1371904 | 0 / 1366075 | 0 / 1390919 |
| group M=L buckets | 0 / 800370 | 0 / 800334 | 0 / 800382 |
| group M=Q | 0 / 1371904 | 0 / 1366075 | 0 / 1390919 |
| length L=Q | 0 / 800370 | 0 / 800334 | 0 / 800382 |
| length M=L | 0 / 800370 | 0 / 800334 | 0 / 800382 |
| length M=Q | 0 / 800370 | 0 / 800334 | 0 / 800382 |
| limit M=L order | **597417** / 800370 (74.6%; 6/8 runs) | **594768** / 800334 (74.3%; 6/8 runs) | **595311** / 800382 (74.4%; 6/8 runs) |
| limit M=L scores | **597417** / 800370 (74.6%; 6/8 runs) | **594768** / 800334 (74.3%; 6/8 runs) | **595311** / 800382 (74.4%; 6/8 runs) |
| limit M=L set | **596819** / 800370 (74.6%; 6/8 runs) | **594768** / 800334 (74.3%; 6/8 runs) | **595310** / 800382 (74.4%; 6/8 runs) |
| max L=Q | 0 / 800370 | 0 / 800334 | **84478** / 800382 (10.6%; 8/8 runs) |
| max M=L | 0 / 800370 | 0 / 800334 | **138395** / 800382 (17.3%; 7/8 runs) |
| max M=Q | 0 / 800370 | 0 / 800334 | **87092** / 800382 (10.9%; 8/8 runs) |
| maxC L=Q | 0 / 800370 | 0 / 800334 | 0 / 800382 |
| maxC M=L | 0 / 800370 | 0 / 800334 | 0 / 800382 |
| maxC M=Q | 0 / 800370 | 0 / 800334 | 0 / 800382 |
| median L=Q | 0 / 11158 | 0 / 11100 | 0 / 11227 |
| median M=L | **6306** / 11158 (56.5%; 6/8 runs) | **8814** / 11100 (79.4%; 6/8 runs) | **7330** / 11227 (65.3%; 6/8 runs) |
| median M=Q | **6306** / 11158 (56.5%; 6/8 runs) | **8814** / 11100 (79.4%; 6/8 runs) | **7330** / 11227 (65.3%; 6/8 runs) |
| medianC M=Q | 0 / 11158 | 0 / 11100 | 0 / 11227 |
| min L=Q | 0 / 800370 | 0 / 800334 | **8538** / 800382 (1.1%; 8/8 runs) |
| min M=L | 0 / 800370 | 0 / 800334 | **6537** / 800382 (0.8%; 7/8 runs) |
| min M=Q | 0 / 800370 | 0 / 800334 | **6649** / 800382 (0.8%; 7/8 runs) |
| some L=Q | 0 / 800370 | 0 / 800334 | 0 / 800382 |
| some M=L | 0 / 800370 | 0 / 800334 | 0 / 800382 |
| some M=Q | 0 / 800370 | 0 / 800334 | 0 / 800382 |
| sum L=Q | 0 / 800370 | **795527** / 800334 (99.4%; 8/8 runs) | **101** / 800382 (0.013%; 3/8 runs) |
| sum M=L | 0 / 800370 | **689939** / 800334 (86.2%; 7/8 runs) | 0 / 800382 |
| sum M=Q | 0 / 800370 | **779649** / 800334 (97.4%; 8/8 runs) | **101** / 800382 (0.013%; 3/8 runs) |
| sumC M=Q | 0 / 800370 | 0 / 800334 | 0 / 800382 |
| topk L=Q order | **799669** / 800370 (99.9%; 8/8 runs) | 0 / 800334 | **799418** / 800382 (99.9%; 8/8 runs) |
| topk L=Q scores | 0 / 800370 | 0 / 800334 | **787831** / 800382 (98.4%; 8/8 runs) |
| topk L=Q set | **783345** / 800370 (97.9%; 8/8 runs) | 0 / 800334 | **796531** / 800382 (99.5%; 8/8 runs) |
| topk M=L order | **796651** / 800370 (99.5%; 8/8 runs) | 0 / 800334 | **797658** / 800382 (99.7%; 8/8 runs) |
| topk M=L scores | 0 / 800370 | 0 / 800334 | **790520** / 800382 (98.8%; 8/8 runs) |
| topk M=L set | **569285** / 800370 (71.1%; 6/8 runs) | 0 / 800334 | **781005** / 800382 (97.6%; 8/8 runs) |
| topk M=Q order | **799389** / 800370 (99.9%; 8/8 runs) | 0 / 800334 | **799578** / 800382 (99.9%; 8/8 runs) |
| topkC L=Q order | 0 / 800370 | 0 / 800334 | 0 / 800382 |
| topkC L=Q scores | 0 / 800370 | 0 / 800334 | 0 / 800382 |
| topkC L=Q set | 0 / 800370 | 0 / 800334 | 0 / 800382 |
| topkC M=L order | 0 / 800370 | 0 / 800334 | 0 / 800382 |
| topkC M=L scores | 0 / 800370 | 0 / 800334 | 0 / 800382 |
| topkC M=L set | 0 / 800370 | 0 / 800334 | 0 / 800382 |
| topkC M=Q order | 0 / 800370 | 0 / 800334 | 0 / 800382 |

### Run A, domain int: mismatches per check (0 = exact at every check)

| check | G=1 failover | G=1 moves | G=4 failover | G=4 moves | G=16 failover | G=16 moves | G=elastic failover | G=elastic moves |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| avg L=Q | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| avg M=L | 0 | 0 | **105** | **54** | 0 | 0 | **22** | **11** |
| avg M=Q | 0 | 0 | **105** | **54** | 0 | 0 | **22** | **11** |
| avgC M=Q | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| countBy L=Q | **26** | **27** | **32** | **19** | **37** | **33** | **33** | **31** |
| countBy M=L | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| countBy M=L buckets | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| countBy M=Q | **26** | **27** | **32** | **19** | **37** | **33** | **33** | **31** |
| countByC M=Q | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| distinct L=Q | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| distinct M=L | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| distinct M=L buckets | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| distinct M=Q | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| distinctC M=Q | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| every L=Q | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| every M=L | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| every M=Q | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| filter L=Q | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| filter M=L | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| filter M=L count | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| filter M=Q | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| group L=Q | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| group M=L | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| group M=L buckets | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| group M=Q | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| length L=Q | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| length M=L | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| length M=Q | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| limit M=L order | 0 | 0 | **98968** | **99856** | **99681** | **99625** | **99607** | **99680** |
| limit M=L scores | 0 | 0 | **98968** | **99856** | **99681** | **99625** | **99607** | **99680** |
| limit M=L set | 0 | 0 | **98968** | **99856** | **99681** | **99027** | **99607** | **99680** |
| max L=Q | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| max M=L | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| max M=Q | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| maxC L=Q | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| maxC M=L | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| maxC M=Q | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| median L=Q | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| median M=L | 0 | 0 | **944** | **990** | **1140** | **1077** | **1176** | **979** |
| median M=Q | 0 | 0 | **944** | **990** | **1140** | **1077** | **1176** | **979** |
| medianC M=Q | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| min L=Q | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| min M=L | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| min M=Q | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| some L=Q | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| some M=L | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| some M=Q | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| sum L=Q | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| sum M=L | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| sum M=Q | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| sumC M=Q | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| topk L=Q order | **99933** | **99879** | **99868** | **99876** | **99944** | **99966** | **100092** | **100111** |
| topk L=Q scores | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| topk L=Q set | **97012** | **98106** | **98088** | **96884** | **98012** | **97994** | **97810** | **99439** |
| topk M=L order | **99725** | **99542** | **99453** | **99599** | **99565** | **99165** | **99877** | **99725** |
| topk M=L scores | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| topk M=L set | 0 | 0 | **96208** | **92684** | **96234** | **93786** | **93318** | **97055** |
| topk M=Q order | **99954** | **99801** | **99873** | **99876** | **99845** | **99966** | **99961** | **100113** |
| topkC L=Q order | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| topkC L=Q scores | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| topkC L=Q set | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| topkC M=L order | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| topkC M=L scores | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| topkC M=L set | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| topkC M=Q order | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

Checks per cell (the n behind each count) are in the raw files. Runs:
- G=1 failover: rows at end 1971; groups at end 1 (max 1); moves 0 (0 rows moved); grows 0; shrinks 0; view rebuilds 100; 309.4 s
- G=1 moves: rows at end 2007; groups at end 1 (max 1); moves 0 (0 rows moved); grows 0; shrinks 0; view rebuilds 0; 108.2 s
- G=4 failover: rows at end 1923; groups at end 4 (max 4); moves 404 (49495 rows moved); grows 0; shrinks 0; view rebuilds 88; 146.9 s
- G=4 moves: rows at end 1997; groups at end 4 (max 4); moves 420 (49089 rows moved); grows 0; shrinks 0; view rebuilds 0; 126.5 s
- G=16 failover: rows at end 1908; groups at end 16 (max 16); moves 390 (25863 rows moved); grows 0; shrinks 0; view rebuilds 96; 296.7 s
- G=16 moves: rows at end 1828; groups at end 16 (max 16); moves 388 (27950 rows moved); grows 0; shrinks 0; view rebuilds 0; 117.6 s
- G=elastic failover: rows at end 1973; groups at end 13 (max 16); moves 400 (102685 rows moved); grows 206; shrinks 194; view rebuilds 93; 306.6 s
- G=elastic moves: rows at end 1950; groups at end 2 (max 16); moves 401 (137945 rows moved); grows 201; shrinks 200; view rebuilds 0; 129.6 s

### Run A, domain float: mismatches per check (0 = exact at every check)

| check | G=1 failover | G=1 moves | G=4 failover | G=4 moves | G=16 failover | G=16 moves | G=elastic failover | G=elastic moves |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| avg L=Q | **99852** | **99128** | **99427** | **99525** | **99135** | **99357** | **98672** | **99855** |
| avg M=L | **96134** | 0 | **98944** | **99295** | **99117** | **99578** | **98661** | **98223** |
| avg M=Q | **97221** | **99128** | **97330** | **98831** | **96207** | **96707** | **97087** | **95559** |
| avgC M=Q | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| countBy L=Q | **38** | **36** | **16** | **23** | **26** | **31** | **25** | **38** |
| countBy M=L | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| countBy M=L buckets | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| countBy M=Q | **38** | **36** | **16** | **23** | **26** | **31** | **25** | **38** |
| countByC M=Q | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| distinct L=Q | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| distinct M=L | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| distinct M=L buckets | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| distinct M=Q | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| distinctC M=Q | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| every L=Q | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| every M=L | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| every M=Q | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| filter L=Q | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| filter M=L | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| filter M=L count | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| filter M=Q | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| group L=Q | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| group M=L | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| group M=L buckets | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| group M=Q | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| length L=Q | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| length M=L | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| length M=Q | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| limit M=L order | 0 | 0 | **99400** | **99726** | **99552** | **99015** | **99226** | **97849** |
| limit M=L scores | 0 | 0 | **99400** | **99726** | **99552** | **99015** | **99226** | **97849** |
| limit M=L set | 0 | 0 | **99400** | **99726** | **99552** | **99015** | **99226** | **97849** |
| max L=Q | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| max M=L | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| max M=Q | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| maxC L=Q | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| maxC M=L | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| maxC M=Q | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| median L=Q | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| median M=L | 0 | 0 | **1511** | **1396** | **1499** | **1373** | **1588** | **1447** |
| median M=Q | 0 | 0 | **1511** | **1396** | **1499** | **1373** | **1588** | **1447** |
| medianC M=Q | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| min L=Q | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| min M=L | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| min M=Q | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| some L=Q | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| some M=L | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| some M=Q | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| sum L=Q | **99870** | **99194** | **99465** | **99596** | **99218** | **99429** | **98868** | **99887** |
| sum M=L | **96134** | 0 | **98973** | **99413** | **99016** | **99404** | **98726** | **98273** |
| sum M=Q | **97345** | **99194** | **97755** | **99028** | **96985** | **95974** | **97477** | **95891** |
| sumC M=Q | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| topk L=Q order | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| topk L=Q scores | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| topk L=Q set | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| topk M=L order | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| topk M=L scores | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| topk M=L set | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| topk M=Q order | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| topkC L=Q order | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| topkC L=Q scores | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| topkC L=Q set | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| topkC M=L order | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| topkC M=L scores | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| topkC M=L set | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| topkC M=Q order | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

Checks per cell (the n behind each count) are in the raw files. Runs:
- G=1 failover: rows at end 1976; groups at end 1 (max 1); moves 0 (0 rows moved); grows 0; shrinks 0; view rebuilds 99; 248.8 s
- G=1 moves: rows at end 1990; groups at end 1 (max 1); moves 0 (0 rows moved); grows 0; shrinks 0; view rebuilds 0; 109.4 s
- G=4 failover: rows at end 1898; groups at end 4 (max 4); moves 431 (43838 rows moved); grows 0; shrinks 0; view rebuilds 97; 167.5 s
- G=4 moves: rows at end 1882; groups at end 4 (max 4); moves 410 (48475 rows moved); grows 0; shrinks 0; view rebuilds 0; 147.7 s
- G=16 failover: rows at end 1827; groups at end 16 (max 16); moves 388 (26800 rows moved); grows 0; shrinks 0; view rebuilds 120; 249.6 s
- G=16 moves: rows at end 1809; groups at end 16 (max 16); moves 381 (25400 rows moved); grows 0; shrinks 0; view rebuilds 0; 120.1 s
- G=elastic failover: rows at end 1987; groups at end 9 (max 16); moves 366 (71493 rows moved); grows 187; shrinks 179; view rebuilds 110; 257.9 s
- G=elastic moves: rows at end 1884; groups at end 10 (max 16); moves 363 (88291 rows moved); grows 186; shrinks 177; view rebuilds 0; 128.0 s

### Run A, domain dirty: mismatches per check (0 = exact at every check)

| check | G=1 failover | G=1 moves | G=4 failover | G=4 moves | G=16 failover | G=16 moves | G=elastic failover | G=elastic moves |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| avg L=Q | 0 | **90** | 0 | 0 | 0 | **9** | **2** | 0 |
| avg M=L | **4** | 0 | **6** | **12** | 0 | 0 | **1** | **4** |
| avg M=Q | **4** | **90** | **6** | **12** | 0 | **9** | **3** | **4** |
| avgC M=Q | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| countBy L=Q | **22** | **49** | **36** | **20** | **45** | **26** | **37** | **33** |
| countBy M=L | 0 | 0 | 0 | 0 | 0 | 0 | **3** | 0 |
| countBy M=L buckets | 0 | 0 | 0 | 0 | 0 | 0 | **328** | 0 |
| countBy M=Q | **22** | **49** | **36** | **20** | **45** | **26** | **34** | **33** |
| countByC M=Q | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| distinct L=Q | **2831** | **2340** | **3820** | **3699** | **3616** | **3231** | **3752** | **3894** |
| distinct M=L | 0 | 0 | **3407** | **3085** | **3139** | **3162** | **3749** | **3794** |
| distinct M=L buckets | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| distinct M=Q | **2831** | **2340** | **3229** | **3652** | **3595** | **3067** | **4099** | **3822** |
| distinctC M=Q | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| every L=Q | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| every M=L | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| every M=Q | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| filter L=Q | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| filter M=L | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| filter M=L count | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| filter M=Q | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| group L=Q | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| group M=L | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| group M=L buckets | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| group M=Q | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| length L=Q | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| length M=L | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| length M=Q | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| limit M=L order | 0 | 0 | **99089** | **99309** | **98967** | **98936** | **99273** | **99737** |
| limit M=L scores | 0 | 0 | **99089** | **99309** | **98967** | **98936** | **99273** | **99737** |
| limit M=L set | 0 | 0 | **99089** | **99309** | **98967** | **98936** | **99273** | **99736** |
| max L=Q | **12918** | **7175** | **12330** | **10357** | **9716** | **4612** | **9622** | **17748** |
| max M=L | **18107** | 0 | **19971** | **20000** | **22104** | **15989** | **15794** | **26430** |
| max M=Q | **11397** | **7175** | **10552** | **12302** | **12811** | **11432** | **9509** | **11914** |
| maxC L=Q | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| maxC M=L | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| maxC M=Q | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| median L=Q | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| median M=L | 0 | 0 | **1090** | **1130** | **1251** | **1176** | **1387** | **1296** |
| median M=Q | 0 | 0 | **1090** | **1130** | **1251** | **1176** | **1387** | **1296** |
| medianC M=Q | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| min L=Q | **3852** | **34** | **20** | **657** | **1927** | **334** | **28** | **1686** |
| min M=L | **375** | 0 | **400** | **414** | **3315** | **339** | **8** | **1686** |
| min M=Q | **4199** | **34** | **420** | **499** | **1428** | **49** | **20** | 0 |
| some L=Q | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| some M=L | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| some M=Q | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| sum L=Q | 0 | **90** | 0 | 0 | 0 | **9** | **2** | 0 |
| sum M=L | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| sum M=Q | 0 | **90** | 0 | 0 | 0 | **9** | **2** | 0 |
| sumC M=Q | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| topk L=Q order | **99827** | **99910** | **99831** | **99848** | **99879** | **99936** | **100012** | **100175** |
| topk L=Q scores | **98803** | **99481** | **94256** | **98383** | **97959** | **99001** | **99942** | **100006** |
| topk L=Q set | **99620** | **99861** | **99248** | **99227** | **98966** | **99585** | **99934** | **100090** |
| topk M=L order | **99566** | **99730** | **99625** | **99671** | **99339** | **99919** | **99746** | **100062** |
| topk M=L scores | **99312** | **97128** | **96949** | **98817** | **98642** | **99895** | **99746** | **100031** |
| topk M=L set | **98852** | **85044** | **99587** | **99207** | **98694** | **99844** | **99746** | **100031** |
| topk M=Q order | **99865** | **99945** | **99831** | **99914** | **99941** | **99930** | **100012** | **100140** |
| topkC L=Q order | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| topkC L=Q scores | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| topkC L=Q set | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| topkC M=L order | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| topkC M=L scores | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| topkC M=L set | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| topkC M=Q order | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

Checks per cell (the n behind each count) are in the raw files. Runs:
- G=1 failover: rows at end 1981; groups at end 1 (max 1); moves 0 (0 rows moved); grows 0; shrinks 0; view rebuilds 87; 168.1 s
- G=1 moves: rows at end 1989; groups at end 1 (max 1); moves 0 (0 rows moved); grows 0; shrinks 0; view rebuilds 0; 114.2 s
- G=4 failover: rows at end 1921; groups at end 4 (max 4); moves 404 (43804 rows moved); grows 0; shrinks 0; view rebuilds 100; 164.7 s
- G=4 moves: rows at end 1927; groups at end 4 (max 4); moves 438 (46424 rows moved); grows 0; shrinks 0; view rebuilds 0; 153.9 s
- G=16 failover: rows at end 1754; groups at end 16 (max 16); moves 403 (24251 rows moved); grows 0; shrinks 0; view rebuilds 92; 158.6 s
- G=16 moves: rows at end 1831; groups at end 16 (max 16); moves 422 (29681 rows moved); grows 0; shrinks 0; view rebuilds 0; 119.2 s
- G=elastic failover: rows at end 1985; groups at end 2 (max 16); moves 387 (86317 rows moved); grows 194; shrinks 193; view rebuilds 117; 165.3 s
- G=elastic moves: rows at end 1958; groups at end 2 (max 16); moves 405 (85221 rows moved); grows 203; shrinks 202; view rebuilds 0; 128.0 s

### Run C: a slot move seen as two cuts (int domain). Mismatches at the cut between the two halves of a move

| check (between fence and open) | fence-first-g4 | fence-first-gelastic | open-first-g4 | open-first-gelastic |
|---|---:|---:|---:|---:|
| avg L=Q | 0 / 78 | 0 / 69 | 0 / 78 | 0 / 69 |
| avg M=L | 76 / 78 | 69 / 69 | 76 / 78 | 69 / 69 |
| avg M=Q | 76 / 78 | 69 / 69 | 76 / 78 | 69 / 69 |
| avgC M=Q | 76 / 78 | 69 / 69 | 76 / 78 | 69 / 69 |
| countBy L=Q | 3 / 3897 | 6 / 3446 | 3 / 3897 | 6 / 3446 |
| countBy M=L | 1866 / 3897 | 3328 / 3446 | 1866 / 3897 | 3328 / 3446 |
| countBy M=L buckets | 0 / 78 | 0 / 69 | 0 / 78 | 0 / 69 |
| countBy M=Q | 1869 / 3897 | 3334 / 3446 | 1869 / 3897 | 3334 / 3446 |
| countByC M=Q | 1866 / 3894 | 3328 / 3440 | 1866 / 3894 | 3328 / 3440 |
| distinct L=Q | 0 / 3894 | 0 / 3440 | 0 / 3894 | 0 / 3440 |
| distinct M=L | 1 / 3894 | 11 / 3440 | 0 / 3894 | 0 / 3440 |
| distinct M=L buckets | 1 / 78 | 2 / 69 | 0 / 78 | 0 / 69 |
| distinct M=Q | 1 / 3894 | 11 / 3440 | 0 / 3894 | 0 / 3440 |
| distinctC M=Q | 1 / 3894 | 11 / 3440 | 0 / 3894 | 0 / 3440 |
| every L=Q | 0 / 78 | 0 / 69 | 0 / 78 | 0 / 69 |
| every M=L | 0 / 78 | 2 / 69 | 0 / 78 | 0 / 69 |
| every M=Q | 0 / 78 | 2 / 69 | 0 / 78 | 0 / 69 |
| filter L=Q | 0 / 123149 | 0 / 115404 | 0 / 123149 | 0 / 115404 |
| filter M=L | 4495 / 123149 | 19081 / 115404 | 0 / 123149 | 0 / 115404 |
| filter M=L count | 70 / 78 | 69 / 69 | 0 / 78 | 0 / 69 |
| filter M=Q | 4495 / 123149 | 19081 / 115404 | 0 / 123149 | 0 / 115404 |
| group L=Q | 0 / 3894 | 0 / 3440 | 0 / 3894 | 0 / 3440 |
| group M=L | 1866 / 3894 | 3328 / 3440 | 0 / 3894 | 0 / 3440 |
| group M=L buckets | 1 / 78 | 2 / 69 | 0 / 78 | 0 / 69 |
| group M=Q | 1866 / 3894 | 3328 / 3440 | 0 / 3894 | 0 / 3440 |
| length L=Q | 0 / 78 | 0 / 69 | 0 / 78 | 0 / 69 |
| length M=L | 76 / 78 | 69 / 69 | 76 / 78 | 69 / 69 |
| length M=Q | 76 / 78 | 69 / 69 | 76 / 78 | 69 / 69 |
| limit M=L order | 78 / 78 | 69 / 69 | 77 / 78 | 67 / 69 |
| limit M=L scores | 78 / 78 | 69 / 69 | 77 / 78 | 67 / 69 |
| limit M=L set | 78 / 78 | 69 / 69 | 77 / 78 | 67 / 69 |
| max L=Q | 0 / 78 | 0 / 69 | 0 / 78 | 0 / 69 |
| max M=L | 1 / 78 | 0 / 69 | 0 / 78 | 0 / 69 |
| max M=Q | 1 / 78 | 0 / 69 | 0 / 78 | 0 / 69 |
| maxC L=Q | 0 / 78 | 0 / 69 | 0 / 78 | 0 / 69 |
| maxC M=L | 1 / 78 | 0 / 69 | 0 / 78 | 0 / 69 |
| maxC M=Q | 1 / 78 | 0 / 69 | 0 / 78 | 0 / 69 |
| median L=Q | 0 / 78 | 0 / 69 | 0 / 78 | 0 / 69 |
| median M=L | 58 / 78 | 52 / 69 | 56 / 78 | 42 / 69 |
| median M=Q | 58 / 78 | 52 / 69 | 56 / 78 | 42 / 69 |
| medianC M=Q | 18 / 78 | 36 / 69 | 14 / 78 | 29 / 69 |
| min L=Q | 0 / 78 | 0 / 69 | 0 / 78 | 0 / 69 |
| min M=L | 0 / 78 | 2 / 69 | 0 / 78 | 0 / 69 |
| min M=Q | 0 / 78 | 2 / 69 | 0 / 78 | 0 / 69 |
| some L=Q | 0 / 78 | 0 / 69 | 0 / 78 | 0 / 69 |
| some M=L | 1 / 78 | 0 / 69 | 0 / 78 | 0 / 69 |
| some M=Q | 1 / 78 | 0 / 69 | 0 / 78 | 0 / 69 |
| sum L=Q | 0 / 78 | 0 / 69 | 0 / 78 | 0 / 69 |
| sum M=L | 76 / 78 | 69 / 69 | 76 / 78 | 69 / 69 |
| sum M=Q | 76 / 78 | 69 / 69 | 76 / 78 | 69 / 69 |
| sumC M=Q | 76 / 78 | 69 / 69 | 76 / 78 | 69 / 69 |
| topk L=Q order | 78 / 78 | 69 / 69 | 78 / 78 | 69 / 69 |
| topk L=Q scores | 0 / 78 | 0 / 69 | 0 / 78 | 0 / 69 |
| topk L=Q set | 74 / 78 | 69 / 69 | 74 / 78 | 69 / 69 |
| topk M=L order | 77 / 78 | 69 / 69 | 76 / 78 | 67 / 69 |
| topk M=L scores | 8 / 78 | 32 / 69 | 0 / 78 | 0 / 69 |
| topk M=L set | 73 / 78 | 69 / 69 | 68 / 78 | 64 / 69 |
| topk M=Q order | 78 / 78 | 69 / 69 | 78 / 78 | 69 / 69 |
| topkC L=Q order | 0 / 78 | 0 / 69 | 0 / 78 | 0 / 69 |
| topkC L=Q scores | 0 / 78 | 0 / 69 | 0 / 78 | 0 / 69 |
| topkC L=Q set | 0 / 78 | 0 / 69 | 0 / 78 | 0 / 69 |
| topkC M=L order | 30 / 78 | 64 / 69 | 0 / 78 | 0 / 69 |
| topkC M=L scores | 8 / 78 | 32 / 69 | 0 / 78 | 0 / 69 |
| topkC M=L set | 30 / 78 | 64 / 69 | 0 / 78 | 0 / 69 |
| topkC M=Q order | 30 / 78 | 64 / 69 | 0 / 78 | 0 / 69 |

After the second half of every move (the "move" cut) the checks above return to Run A's counts; see the raw files.
- C-move-fence-first-g4: rows at end 1911; groups at end 4 (max 4); moves 78 (8818 rows moved); grows 0; shrinks 0; view rebuilds 0; 42.2 s
- C-move-fence-first-gelastic: rows at end 2015; groups at end 2 (max 9); moves 69 (37600 rows moved); grows 35; shrinks 34; view rebuilds 0; 41.7 s
- C-move-open-first-g4: rows at end 1911; groups at end 4 (max 4); moves 78 (8818 rows moved); grows 0; shrinks 0; view rebuilds 0; 49.2 s
- C-move-open-first-gelastic: rows at end 2015; groups at end 2 (max 9); moves 69 (37600 rows moved); grows 35; shrinks 34; view rebuilds 0; 43.1 s

### Run B: views that differ, as values (bytes in brackets where only the order differs), G = 4 and 16 summed

Each cell: comparisons that differed / comparisons made. "interleave" = two servers that fold every group, interleaved differently; "rebuilt" = a fresh view on the same source; "snapshot" = a fresh source loaded from the rows in key order.

| view | int: interleave | rebuilt | snapshot | float: interleave | rebuilt | snapshot | dirty: interleave | rebuilt | snapshot |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| avg | 0 | 0 | 0 | **992/1002** | **100/102** | **102/102** | 0 | 0 | 0 |
| az(points) full order | **996/1002** | 0 | **102/102** | **15/1002** | 0 | **102/102** | **202/202** | **22/22** | **22/22** |
| distinct(room) | 0 (bytes 1002/1002) | 0 (bytes 102/102) | 0 (bytes 102/102) | 0 (bytes 1002/1002) | 0 (bytes 102/102) | 0 (bytes 102/102) | 0 (bytes 202/202) | 0 (bytes 22/22) | **21/22** |
| every | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| filter | 0 (bytes 1002/1002) | 0 (bytes 102/102) | 0 (bytes 102/102) | 0 (bytes 1002/1002) | 0 (bytes 102/102) | 0 (bytes 102/102) | 0 (bytes 202/202) | 0 (bytes 22/22) | 0 (bytes 22/22) |
| group(room) | 0 (bytes 1002/1002) | 0 (bytes 102/102) | 0 (bytes 102/102) | 0 (bytes 1002/1002) | 0 (bytes 102/102) | 0 (bytes 102/102) | 0 (bytes 202/202) | 0 (bytes 22/22) | 0 (bytes 22/22) |
| length | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| length(room) counts | 0 (bytes 1002/1002) | 0 (bytes 102/102) | 0 (bytes 102/102) | 0 (bytes 1002/1002) | 0 (bytes 102/102) | 0 (bytes 102/102) | 0 (bytes 202/202) | 0 (bytes 22/22) | 0 (bytes 22/22) |
| limit(10) | **135/1002** | 0 | **102/102** | **116/1002** | 0 | **102/102** | **61/202** | 0 | **22/22** |
| max | 0 | 0 | 0 | 0 | 0 | 0 | **1/202** | **3/22** | **7/22** |
| maxC (numbers only) | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| median | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| min | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| some | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| sum | 0 | 0 | 0 | **993/1002** | **100/102** | **102/102** | 0 | 0 | 0 |
| topk za(points,10) | **28/1002** | 0 | **102/102** | 0 | 0 | 0 | **200/202** | **22/22** | **22/22** |
| topkC az(cmpTotal,10) | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
