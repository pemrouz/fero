### Claim 1: a step (ns)

| rows | direct | kept verb | lens1 | lens2 | at2 | data handle2 | map | step (same key) | step (spread) | kept over direct | at over direct |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1000 | 55.3-65.5 | 64.3-65.6 | 93.3-96.1 | 174-178 | 60.7-68.9 | 177-199 | 14.3-18.4 | 54.7-56.1 | 60.7-66.8 | 0.1-10.1 | 3.4-10.9 |
| 100000 | 63.9-73.2 | 64.7-71 | 104-119 | 203-236 | 84.7-93.4 | 193-227 | 27.8-33.7 | 69.4-83.3 | 118-236 | -4-7.1 | 11.5-29.5 |
| 1000000 | 73.8-112 | 71.5-135 | 116-127 | 235-292 | 147-228 | 234-331 | 27.2-62.2 | 78.3-99.2 | 188-210 | -5.8-23.6 | 60.7-154 |

### Claim 1 follow-up: four ways to build a step (ns per step: (two steps and the read − the direct read) / 2)

| rows | keys | proto | handler | shared | plain | direct read |
|---|---|---|---|---|---|---|
| 100000 | same | 75.2-82.2 | 59.6-69.9 | 53.4-60.4 | 14.9-16.6 | 44.6-49.2 |
| 100000 | spread | 105-137 | 102-126 | 99.7-119 | 58-89.7 | 425-447 |
| 1000000 | same | 76.8-105 | 52.4-94 | 46.7-89.6 | 16.3-48.1 | 72.1-83.4 |
| 1000000 | spread | 192-229 | 153-203 | 114-189 | 71.3-106 | 1118-1271 |

### Claim 2: bytes kept per distinct key (100,000 keys)

| way | B per key |
|---|---|
| one | 0-0.3 |
| two | 0-0.3 |
| kept | 296-296 |
| handle2 | 1333-1333 |

### Claim 3: a write (ns)

| rows | f.set([k,n],v) | L[k].n.set(v) | kept.set(v) | f.at(k,n).set(v) | data handle today | steps over direct | kept over direct |
|---|---|---|---|---|---|---|---|
| 10000 | 732-947 | 1046-1135 | 883-959 | 718-788 | 1656-1701 | 176-403 | -18.5-227 |
| 100000 | 1187-1283 | 1592-1772 | 1323-1465 | 1203-1226 | 2177-2375 | 309-585 | 40.3-259 |
| 1000000 | 751-898 | 1047-1170 | 873-1107 | 780-786 | 1658-1843 | 225-420 | -25.7-313 |

### Claim 6: set-up (ns each, 10,000 of each)

| what | ns |
|---|---|
| here (kept lens) | 163-169 |
| here (at) | 69.8-74.2 |
| connect fn (kept lens) | 691-739 |
| connect prop (kept lens) | 904-1054 |
| tap (kept lens) | 140-323 |
| lookup + count | 38.8-44.5 |
| weakref | 491-557 |
| register | 79.1-127 |
| register with token | 255-261 |
| target registration | 584-668 |

| rows in all | rows in the room | first picture ms |
|---|---|---|
| 10000 | 100 | 0.17-0.23 |
| 1000000 | 100 | 0.16-0.19 |
| 100000 | 1 | 0.13-0.15 |
| 1000000 | 10000 | 0.72-0.78 |
| 100000 | 10000 | 0.67-0.68 |

### Claim 6 follow-up: a registration, B made in one job (ns each, the loop and clock subtracted)

| process | runs | way | B=1 | B=10 | B=100 | B=1000 | B=10000 |
|---|---|---|---|---|---|---|---|
| a clean process | 3 | weakref | 158-261 | 116-151 | 86.7-97.2 | 81.8-85.2 | 126-137 |
| a clean process | 3 | register | 57.3-85.6 | 39-45.1 | 23.6-38.9 | 22-36.4 | 21.2-51.7 |
| a clean process | 3 | both | 183-334 | 157-187 | 111-133 | 112-124 | 147-170 |
| a clean process | 3 | object | 44.8-61.9 | 8.9-17.4 | 7.3-11.3 | 8.7-10.7 | 9.3-11.3 |
| 100,000 rows held | 3 | weakref | 127-182 | 105-111 | 81.7-105 | 75.9-88.3 | 130-145 |
| 100,000 rows held | 3 | register | 13.4-53 | 46.6-62.7 | 46.8-55 | 42.3-52.5 | 52.2-77 |
| 100,000 rows held | 3 | both | 165-226 | 160-183 | 139-151 | 129-140 | 169-184 |
| 100,000 rows held | 3 | object | 16-56.9 | 18.3-30.3 | 9.7-19 | 10.8-18.4 | 12-16.2 |

### Claim 6 follow-up: a first picture of a 100-row room, with and without a full collection right before (µs)

| what | runs | p50 | p90 |
|---|---|---|---|
| tap + close, no collection before | 3 | 26-27.6 | 37.2-41.1 |
| tap + close, a full collection before | 3 | 149-166 | 185-218 |
| data connect + dispose, a full collection before | 3 | 37.1-42.4 | 51-63.1 |
| data connect + dispose, no collection before | 3 | 0.8-0.9 | 1.2-1.4 |

### Claim 8: K lenses on K rows (ns per write, 100,000 rows)

| K | lens (keyed index) | data path connect today |
|---|---|---|
| 0 | 1243-1388 | 2947-3293 |
| 10 | 1495-1568 | n/a |
| 100 | 1467-1585 | 5448-5867 |
| 1000 | 1388-1516 | 25849-26238 |
| 10000 | 1659-1692 | 367894-396546 |
| 100000 | 2344-2379 | n/a |

ratio K=10,000 / K=0: 1.2-1.36; K=100,000 / K=0: 1.69-1.91

### Claim 10: tap((c) => …) (ns per write, 10,000 rows)

| derived | ns |
|---|---|
| nothing_over_none | 149-165 |
| changes_over_nothing | -36--11.2 |
| now_over_nothing | -44.7-88.5 |
| recs_over_nothing | 130-166 |
| data_param_over_bare | 1289-1772 |
| dataSink_over_none | 102-124 |
| lens_over_dataSink | 38.2-46.1 |

### Claim 11: 10,000 weak links against 10,000 strong sinks (ns per commit)

| sinks | runs | strong ns/commit | weak ns/commit | ratio | per link delta ns | deref check ns |
|---|---|---|---|---|---|---|
| no work | 3 | 92520-151903 | 384795-517224 | 3.73-4.61 | 28.16-35.02 | 26.38-30.46 |
| work, own target | 3 | 269058-304186 | 586472-661134 | 2.18-2.21 | 31.74-34.24 | 27.53-34.77 |
| work, shared object (first harness) | 1 | 187469-198405 | 638452-660066 | 3.41 | 45.1 | 29.46 |

### Claim 12: forced collection

| commit before collection ms | calls then | commit after gc ms | calls after gc | ended by check | round 2 ended by finalizer |
|---|---|---|---|---|---|
| 0.8-0.9 | 1000 | 1.24-1.3 | 0 | 1000 | 1000 |

### Claim 13: natural collection (links ended by 0.1/1/5/15/30 s, of 1,000)

| where | age | mode | by 0.1 s | by 1 s | by 5 s | by 15 s | by 30 s | p50 ms | p99 ms | how |
|---|---|---|---|---|---|---|---|---|---|---|
| node | young | idle | 0 | 0 | 999 | 999 | 999 | 1189-1426 | 1189-1427 | {"collected":999} |
| node | young | busy | 999 | 999 | 999 | 999 | 999 | 7 | 7-8 | {"collected":999} |
| node | young | busy-writes | 999 | 999 | 999 | 999 | 999 | 7-8 | 8 | {"collected":999} |
| node | old | idle | 1000 | 1000 | 1000 | 1000 | 1000 | 330-388 | 331-389 | {"collected":1000} |
| node | old | busy | 1000 | 1000 | 1000 | 1000 | 1000 | 342-361 | 342-362 | {"collected":1000} |
| node | old | busy-writes | 1000 | 1000 | 1000 | 1000 | 1000 | 327-398 | 328-398 | {"collected":1000} |
| browser | - | idle | 0 | 0 | 0 | 0 | 0 | n/a | n/a | {} |
| browser | - | busy | 0 | 0 | 0 | 0 | 0 | n/a | n/a | {} |
| browser | - | busy-writes | 0 | 0 | 0 | 0 | 0 | n/a | n/a | {} |

### Claim 15: the capture trap

```json
{
 "exp": "E-55",
 "node": "v22.22.0",
 "claim": 15,
 "bench": "capture",
 "closingTargetCollected": false,
 "freeTargetCollected": true,
 "domClosingCollected": false,
 "liveLinks": 3,
 "devWarnings": [
  "the net ended links on f.k1: close them, or end them with a scope",
  "dev: a link on f.k1 feeds a detached DOM node that is still alive: does its function close over its target?"
 ]
}
```

### Claim 16: a view pushed to the server (push) against the room held and the view run here (local)

| room rows | shapes | mode | server ns/change | server ns/view | encodes/change | wire B/change | client ns/change | first picture B/shape | server heap B/shape | answers right |
|---|---|---|---|---|---|---|---|---|---|---|
| 100 | 1 | push | 17601-22932 | 17601-22932 | 0.2 | 31.6 | 821-987 | 705 | 76192-76248 | true |
| 100 | 1 | local | 9203-11373 | n/a | 1 | 60.2 | 15574-20512 | 6002 | n/a | true |
| 100 | 10 | push | 43762-57977 | 4376-5798 | 1.59 | 264 | 4084-6690 | 707 | 26698-26702 | true |
| 100 | 10 | local | 8249-9514 | n/a | 1 | 60.2 | 41320-48564 | 5999 | n/a | true |
| 100 | 100 | push | 242925-263783 | 2429-2638 | 13.79 | 2281 | 28838-30556 | 677 | 12152-12203 | true |
| 100 | 100 | local | 7635-8839 | n/a | 1 | 60.2 | 163003-183107 | 6004 | n/a | true |
| 100 | 1000 | push | 2981422-3227534 | 2981-3228 | 161 | 26455 | 373770-396583 | 680 | 9937 | true |
| 100 | 1000 | local | 8314-9212 | n/a | 1 | 60.2 | 2265855-2824939 | 5996 | n/a | true |
| 1000 | 1 | push | 17531-20026 | 17531-20026 | 0.02 | 3 | 224-323 | 721 | 172328-172568 | true |
| 1000 | 1 | local | 7989-11109 | n/a | 1 | 61.2 | 13283-17588 | 61706 | n/a | true |
| 1000 | 10 | push | 47011-52443 | 4701-5244 | 0.27 | 44.9 | 1019-1145 | 725 | 97226-97266 | true |
| 1000 | 10 | local | 8628-12047 | n/a | 1 | 61.2 | 40760-45774 | 61677 | n/a | true |
| 1000 | 100 | push | 325509-394667 | 3255-3947 | 1.35 | 229 | 4318-5145 | 730 | 72929-72930 | true |
| 1000 | 100 | local | 10993-12939 | n/a | 1 | 61.2 | 326114-398197 | 61694 | n/a | true |
| 1000 | 1000 | push | 4528118-5227307 | 4528-5227 | 17.9 | 3034 | 45258-50000 | 722 | 68048 | true |
| 1000 | 1000 | local | 9042-9640 | n/a | 1 | 61.2 | 5899241-6209387 | 61686 | n/a | true |
| 10000 | 1 | push | 28760-38146 | 28760-38146 | 0 | 0.3 | 96-115 | 745 | 1609152-1609592 | true |
| 10000 | 1 | local | 8305-9177 | n/a | 1 | 62.2 | 17157-18405 | 636647 | n/a | true |
| 10000 | 10 | push | 90476-111014 | 9048-11101 | 0.02 | 3.4 | 195-240 | 749 | 897126-897721 | true |
| 10000 | 10 | local | 8742-9244 | n/a | 1 | 62.2 | 86303-104288 | 636701 | n/a | true |
| 10000 | 100 | push | 1046272-1169333 | 10463-11693 | 0.25 | 42.8 | 940-1097 | 746 | 738591-738592 | true |
| 10000 | 100 | local | 10663-12651 | n/a | 1 | 62.2 | 1185265-1239356 | 636734 | n/a | true |
| 100000 | 1 | push | 133461-214908 | 133461-214908 | 0 | 0.1 | 84-96 | 765 | 12802016-12802616 | true |
| 100000 | 1 | local | 9158-14079 | n/a | 1 | 63.2 | 41050-44297 | 6566627 | n/a | true |
| 100000 | 10 | push | 520028-540203 | 52003-54020 | 0 | 0 | 0 | 763 | 8236086-8236090 | true |
| 100000 | 10 | local | 9047-10293 | n/a | 1 | 63.2 | 545380-621322 | 6566919 | n/a | true |

### Claim 16 follow-up: one gt().za(10) view in data alone (ns per field write)

| rows | seeded+promote: no view | seeded: no view | written: no view | seeded+promote: the view adds | seeded: the view adds | written: the view adds |
|---|---|---|---|---|---|---|
| 1000 | 1034-1178 | 952-1031 | 1024-1250 | 2300-2408 | 1226-2062 | 1043-1838 |
| 10000 | 1476-2213 | 1277-1614 | 1278-1701 | 3118-4044 | 1926-2670 | 1957-2361 |
| 100000 | 2236-2595 | 1907-2262 | 2087-2804 | 11764-12496 | 9258-10549 | 10054-11980 |

### Claim 20: 100,000 reads through `await lens`

| server GETs | server SUBs | client selections | cache rows | heap delta B | µs per read |
|---|---|---|---|---|---|
| 100000 | 0 | 0 | 0 | 197416-197536 | 42.9-44.4 |

### Claim 19: depth 2 against flat (storeBytes: rows and structure)

| rows | rows/partition | way | fold ns/record | fold vs flat | B per partition over flat | 100-row... first picture ms | row write ns | key +B (JSON) |
|---|---|---|---|---|---|---|---|---|
| 1000 | 1 | flat | 905-924 | 1-1.02 | 0 | 0.03-0.04 | 672-690 | 2 |
| 1000 | 1 | flatidx | 969-1019 | 1.07-1.13 | 229 | 0 | 676-925 | 2 |
| 1000 | 1 | d2data | 1069-1247 | 1.18-1.38 | 1425 | 0-0 | 943-1136 | 2 |
| 1000 | 1 | d2plain | 161-214 | 0.18-0.24 | 122 | 0 | 185-220 | 2 |
| 1000 | 1 | flatplain | 186-207 | 0.21-0.23 | 150 | 0 | 170-180 | 2 |
| 1000 | 100 | flat | 851-1068 | 1-1.26 | 0 | 0.03-0.05 | 710-846 | 2 |
| 1000 | 100 | flatidx | 962-1149 | 1.13-1.35 | 5122 | 0-0 | 723-767 | 2 |
| 1000 | 100 | d2data | 894-951 | 1.05-1.12 | 3968 | 0 | 697-902 | 2 |
| 1000 | 100 | d2plain | 142-172 | 0.17-0.2 | -7006 | 0 | 168-201 | 2 |
| 1000 | 100 | flatplain | 169-195 | 0.2-0.23 | -2723 | 0-0 | 180-184 | 2 |
| 100000 | 1 | flat | 2040-2108 | 1-1.03 | 0 | 3.4-3.64 | 2318-2462 | 2 |
| 100000 | 1 | flatidx | 2327-2434 | 1.14-1.19 | 237-237 | 0 | 2519-2665 | 2 |
| 100000 | 1 | d2data | 3188-3453 | 1.56-1.69 | 1124-1124 | 0-0 | 3303-3707 | 2 |
| 100000 | 1 | d2plain | 816-1106 | 0.4-0.54 | 119 | 0-0 | 1339-1464 | 2 |
| 100000 | 1 | flatplain | 1208-1278 | 0.59-0.63 | 177-177 | 0 | 1297-1773 | 2 |
| 100000 | 100 | flat | 1771-2140 | 1-1.21 | 0 | 2.98-3.43 | 2129-2501 | 2 |
| 100000 | 100 | flatidx | 1781-2174 | 1.01-1.23 | 5085 | 0.04-0.05 | 2233-2545 | 2 |
| 100000 | 100 | d2data | 1940-2077 | 1.1-1.17 | 358 | 0.01-0.02 | 2487-2871 | 2 |
| 100000 | 100 | d2plain | 609-683 | 0.34-0.39 | -8889 | 0 | 957-1030 | 2 |
| 100000 | 100 | flatplain | 740-918 | 0.42-0.52 | -3050 | 0.03-0.04 | 849-1048 | 2 |
| 100000 | 10000 | flat | 1731-1900 | 1-1.1 | 0 | 3.02-3.12 | 2043-2636 | 2 |
| 100000 | 10000 | flatidx | 1765-2100 | 1.02-1.21 | 567854-567858 | 2.02-2.12 | 2163-2280 | 2 |
| 100000 | 10000 | d2data | 1690-1912 | 0.98-1.1 | -237222 | 0.21-0.3 | 2144-2528 | 2 |
| 100000 | 10000 | d2plain | 557-638 | 0.32-0.37 | -793665 | 0.2-0.23 | 853-982 | 2 |
| 100000 | 10000 | flatplain | 684-926 | 0.4-0.53 | -245639 | 2.04-2.6 | 892-955 | 2 |
| 1000000 | 100 | flat | 2840-3005 | 1-1.06 | 0 | 32.64-40.22 | 3227-3378 | 2 |
| 1000000 | 100 | flatidx | 2830-3134 | 1-1.1 | 5102 | 0.07-0.1 | 3251-3315 | 2 |
| 1000000 | 100 | d2data | 2989-3214 | 1.05-1.13 | -4139 | 0.01-0.01 | 3744-3923 | 2 |
| 1000000 | 100 | d2plain | 1344-1351 | 0.47-0.48 | -7130 | 0 | 1737-1932 | 2 |
| 1000000 | 100 | flatplain | 1905-2129 | 0.67-0.75 | 140-140 | 0.1-0.11 | 1731-2029 | 2 |
| 1000000 | 10000 | flat | 2499-2563 | 1-1.03 | 0 | 30.76-32.28 | 2812-3099 | 2 |
| 1000000 | 10000 | flatidx | 2694-2739 | 1.08-1.1 | 567815 | 6.31-6.82 | 2802-3014 | 2 |
| 1000000 | 10000 | d2data | 2412-2495 | 0.97-1 | -71466 | 0.17-0.21 | 2790-3135 | 2 |
| 1000000 | 10000 | d2plain | 1118-1288 | 0.45-0.52 | -626029 | 0.22-0.26 | 1457-1637 | 2 |
| 1000000 | 10000 | flatplain | 1343-1432 | 0.54-0.57 | -144294 | 6.57-6.77 | 1271-1592 | 2 |
| 1000000 | 1 | flat | 2773-2860 | 1-1.03 | 0 | 34.92-37.88 | 2975-3165 | 2 |
| 1000000 | 1 | flatidx | 3136-3201 | 1.13-1.15 | 229 | 0-0.01 | 3098-3436 | 2 |
| 1000000 | 1 | d2data | 4514-4906 | 1.63-1.77 | 1123-1123 | 0-0.01 | 5268-5624 | 2 |
| 1000000 | 1 | d2plain | 1627-1742 | 0.59-0.63 | 129 | 0 | 1978-2153 | 2 |
| 1000000 | 1 | flatplain | 2183-2381 | 0.79-0.86 | 182-182 | 0-0.01 | 1644-1888 | 2 |

### Claim 23: asOf, fat nodes fed from data's prev (1,000,000 records)

| rows | mode | hot | ns/record | kept B/version | step ns | row at version ns | hot row versions | hot row ns | checks wrong |
|---|---|---|---|---|---|---|---|---|---|
| 100000 | base |  | 1843-2070 | -20.2 | n/a | n/a | n/a | n/a |  |
| 100000 | fat |  | 3576-3837 | 103 | 10.02-10.63 | 612-924 | n/a | n/a | 0/560 0/560 0/560 |
| 1000000 | base |  | 2453-2512 | -133 | n/a | n/a | n/a | n/a |  |
| 1000000 | fat |  | 4151-4412 | 285 | 9.72-10.25 | 1093-1372 | n/a | n/a | 0/560 0/560 0/560 |
| 1000000 | fat | 0.15 | 3742-3932 | 268 | 10.38-11.89 | 1033-1296 | 150473 | 142-211 | 0/560 0/560 0/560 |

### Claim 21: rate

| awaited /s | not awaited /s | ratio |
|---|---|---|
| 239-240 | 122054-134082 | 510-558 |

### Seeded runs and counters

```json
{"exp":"E-55","node":"v22.22.0","claim":4,"bench":"callspace","cases":22,"passed":22,"failing":[]}
```
```json
{"exp":"E-55","node":"v22.22.0","claim":7,"bench":"picture-then-changes","seeds":1000,"sinks":93326,"doubled":0,"missed":0,"unequal":0,"propUnequal":0,"firstsNotEmpty":0,"failedSeeds":[]}
```
```json
{"exp":"E-55","node":"v22.22.0","claim":14,"bench":"collector-adversary","target-only":{"programs":3,"collectorSeeds":1000,"distinctResultsPerProgram":1,"distinctLeakyRowsPerProgram":33.666666666666664,"linksEndedByNet":58178,"upstreamSubsRange":[6,10]},"shared":{"programs":3,"collectorSeeds":1000,"distinctResultsPerProgram":432.6666666666667,"distinctLeakyRowsPerProgram":8,"linksEndedByNet":57679,"upstreamSubsRange":[6,10]}}
```
```json
{"exp":"E-55","node":"v22.22.0","claim":17,"bench":"commute","seeds":1000,"chainPositions":3000,"badRunsKeyedClient":239,"badRunsOrderKept":0,"badOrderedChains":[],"chains":438,"failingChains":99,"failing":[{"chain":"reverse","runs":43,"bad":43,"herePositions":[1]},{"chain":"za","runs":57,"bad":32,"herePositions":[1]},{"chain":"top","runs":56,"bad":16,"herePositions":[1]},{"chain":"az.az","runs":9,"bad":7,"herePositions":[2]},{"chain":"gte.az","runs":5,"bad":5,"herePositions":[2]},{"chain":"between.az","runs":5,"bad":5,"herePositions":[2]},{"chain":"lt.az","runs":5,"bad":4,"herePositions":[2]},{"chain":"az.top","runs":7,"bad":4,"herePositions":[2]},{"chain":"lt.reverse","runs":3,"bad":3,"herePositions":[2]},{"chain":"top.az","runs":4,"bad":3,"herePositions":[2]},{"chain":"za.za","runs":4,"bad":3,"herePositions":[2]},{"chain":"lte.az.reverse","runs":3,"bad":3,"herePositions":[3]},{"chain":"reverse.az","runs":3,"bad":3,"herePositions":[2]},{"chain":"az.top.az","runs":3,"bad":3,"herePositions":[3]},{"chain":"lt.top","runs":3,"bad":2,"herePositions":[2]},{"chain":"reverse.reverse","runs":2,"bad":2,"herePositions":[2]},{"chain":"reverse.za","runs":3,"bad":2,"herePositions":[2]},{"chain":"limit.az","runs":6,"bad":2,"herePositions":[2]},{"chain":"top.top.reverse","runs":2,"bad":2,"herePositions":[3]},{"chain":"between.az.az","runs":3,"bad":2,"herePositions":[3]},{"chain":"lte.reverse","runs":2,"bad":2,"herePositions":[2]},{"chain":"gte.top","runs":2,"bad":2,"herePositions":[2]},{"chain":"lt.gte.az","runs":2,"bad":2,"herePositions":[3]},{"chain":"reverse.top.az","runs":2,"bad":2,"herePositions":[3]},{"chain":"top.az.az","runs":3,"bad":2,"herePositions":[3]},{"chain":"az.reverse","runs":2,"bad":2,"herePositions":[2]},{"chain":"az.za.top","runs":2,"bad":2,"herePositions":[3]},{"chain":"between.reverse","runs":2,"bad":2,"herePositions":[2]},{"chain":"lte.az","runs":2,"bad":2,"herePositions":[2]},{"chain":"between.za","runs":2,"bad":2,"herePositions":[2]},{"chain":"gt.reverse","runs":2,"bad":2,"herePositions":[2]},{"chain":"reverse.top","runs":2,"bad":2,"herePositions":[2]},{"chain":"az.limit","runs":2,"bad":2,"herePositions":[2]},{"chain":"az.between.az","runs":3,"bad":2,"herePositions":[3]},{"chain":"lt.za.reverse","runs":2,"bad":1,"herePositions":[3]},{"chain":"lt.za","runs":2,"bad":1,"herePositions":[2]},{"chain":"gt.za.za","runs":1,"bad":1,"herePositions":[3]},{"chain":"gt.top","runs":2,"bad":1,"herePositions":[2]},{"chain":"gt.az","runs":6,"bad":1,"herePositions":[2]},{"chain":"gt.lte.reverse","runs":1,"bad":1,"herePositions":[3]}],"passingSample":["gte.lt","gte.gt.gt","lt.lt.length","lt.length","gte.az.gte","min","max","gte.avg","lt.max","gte.lte.between","lt.gte.reverse","gt.sum","gt.reverse.gt","lt.limit.lt","gt.length","lt.az.max","lt.lte","gt.gte.top","lt.lt.min","gt.lt","lt.top.gte","gt.az.sum","avg","reverse.min","reverse.reverse.gt","reverse.gte","reverse.reverse.min","gt.reverse.lt","gt.min","gt.za.lte"]}
```
```json
{"exp":"E-55","node":"v22.22.0","claim":7,"bench":"net-reconnect","seeds":1000,"steps":43794,"sinks":11865,"disconnects":4337,"resumes":5968,"pictures":4743,"doubled":0,"missed":0,"phantom":0,"unequal":0,"failedSeeds":[]}
```
```json
{"exp":"E-55","node":"v22.22.0","claim":9,"bench":"net-share","links":2000,"writes":200,"serverSubs":1,"serverEncodes":200,"framesToThisClient":200,"decodesHere":200,"textBuildsHere":200,"everyTargetCurrent":true}
```
```json
{"exp":"E-55","node":"v22.22.0","claim":9,"bench":"share","links":2000,"counts":{"upstreamSubs":1,"framesDecoded":100,"writes":100,"foldsInCache":100,"textBuilds":100,"deliveries":100000,"selections":1,"allTargetsCurrent":true},"unsubBeforeLinger":0,"lingerTimers":1,"unsubAfterLinger":1,"selectionsAfter":0,"cacheRowsAfter":0}
```
```json
{"exp":"E-55","node":"v22.22.0","claim":18,"bench":"leader","servers":3,"freshTable":{"calls":1000,"clientTrips":1000,"serverForwards":0,"commits":1000,"redirects":0,"tripsPerCall":1,"commitsPerCall":1},"afterMoveFirstCall":{"calls":30,"clientTrips":60,"redirects":30,"serverForwards":0,"commits":30},"afterMoveNextCall":{"calls":30,"clientTrips":30,"redirects":0,"serverForwards":0,"commits":30},"noPath":{"calls":3000,"clientTrips":3000,"serverForwards":1986,"extraTripShare":0.662,"expected":0.667,"commits":3000}}
```
```json
{"exp":"E-55","node":"v22.22.0","claim":18,"bench":"leader","servers":5,"freshTable":{"calls":1000,"clientTrips":1000,"serverForwards":0,"commits":1000,"redirects":0,"tripsPerCall":1,"commitsPerCall":1},"afterMoveFirstCall":{"calls":30,"clientTrips":60,"redirects":30,"serverForwards":0,"commits":30},"afterMoveNextCall":{"calls":30,"clientTrips":30,"redirects":0,"serverForwards":0,"commits":30},"noPath":{"calls":3000,"clientTrips":3000,"serverForwards":2391,"extraTripShare":0.797,"expected":0.8,"commits":3000}}
```
```json
{"exp":"E-55","node":"v22.22.0","claim":21,"bench":"marks-sim","marks-move":{"seeds":1000,"badSeeds":0,"lost":0,"doubled":0,"applied":54018,"refused":5982,"skipped":121758,"moves":19686,"crashes":11421,"twins":1000,"notDone":0},"nomarks":{"seeds":1000,"badSeeds":1000,"lost":0,"doubled":7006,"applied":73552,"refused":8217,"skipped":137277,"moves":19686,"crashes":11418,"twins":1000,"notDone":0}}
```
```json
{"exp":"E-55","node":"v22.22.0","claim":7,"bench":"picture-then-changes","seeds":300,"sinks":28117,"doubled":1396,"missed":1113,"unequal":0,"propUnequal":0,"firstsNotEmpty":0,"failedSeeds":[1,2,3,4,5,6,7,8,9,10]}
```
```json
{"exp":"E-55","node":"v22.22.0","claim":7,"bench":"picture-then-changes","seeds":300,"sinks":27902,"doubled":514,"missed":392,"unequal":204,"propUnequal":0,"firstsNotEmpty":0,"failedSeeds":[1,2,3,4,5,6,7,9,10,11]}
```
```json
{"exp":"E-55","node":"v22.22.0","claim":7,"bench":"picture-then-changes","seeds":300,"sinks":28428,"doubled":0,"missed":0,"unequal":536,"propUnequal":83,"firstsNotEmpty":0,"failedSeeds":[32,112,118,130,228]}
```
```json
{"exp":"E-55","node":"v22.22.0","claim":7,"bench":"net-reconnect","seeds":100,"steps":4441,"sinks":1205,"disconnects":418,"resumes":651,"pictures":435,"doubled":0,"missed":0,"phantom":0,"unequal":999,"failedSeeds":[1,4,5,7,8,15,17,23,24,28]}
```
```json
{"exp":"E-55","node":"v22.22.0","claim":7,"bench":"net-reconnect","seeds":100,"steps":4441,"sinks":1205,"disconnects":418,"resumes":610,"pictures":476,"doubled":0,"missed":0,"phantom":697,"unequal":0,"failedSeeds":[1,2,3,5,6,8,9,10,11,13]}
```

### Types and imports

- {"exp":"E-55","claim":5,"config":"tsconfig","tsc":"Version 6.0.2","exit":0,"errors":""}
- {"exp":"E-55","claim":5,"config":"tsconfig.neg","tsc":"Version 6.0.2","exit":0,"errors":""}
- {"exp":"E-55","claim":5,"config":"tsconfig.screens","tsc":"Version 6.0.2","exit":0,"errors":""}
- {"exp":"E-55","claim":5,"config":"negatives stripped","errors":"_stripped.ts(9,27): error TS2551 _stripped.ts(11,37): error TS2769 _stripped.ts(13,40): error TS2339 _stripped.ts(15,19): error TS2349 _stripped.ts(27,34): error TS2339 _stripped.ts(29,29): error TS2339 _stripped.ts(31,16): error TS2349 _stripped.ts(34,34): error TS2339 _stripped.ts(36,24): error TS2339 _stripped.ts(39,9): error TS232
- {"exp":"E-55","claim":5,"config":"typed assignment","errors":"assign.ts(8,19): error TS2540: Cannot assign to 'stock' because it is a read-only property assign.ts(12,1): error TS2322: Type 'number' is not assignable to type '{ set(v: number): void; }' assign.ts(17,9): error TS2339: Property 'set' does not exist on type 'number' "}
- {"exp":"E-55","claim":5,"config":"typed assignment, mapped accessors","errors":"error TS1005: ']' expected error TS1128: Declaration or statement expected "}
- {"exp":"E-55","claim":24,"client":"a-type-Shop","config":"vms","node":"v22.22.0","nodeRanServer":0,"nodeOutput":"client ran shop ","tscErrors":"","esbuildShipsServer":"0","esbuildError":""}
- {"exp":"E-55","claim":24,"client":"a-type-Shop","config":"plain","node":"v22.22.0","nodeRanServer":0,"nodeOutput":"client ran shop ","tscErrors":"","esbuildShipsServer":"0","esbuildError":""}
- {"exp":"E-55","claim":24,"client":"b-plain-Shop","config":"vms","node":"v22.22.0","nodeRanServer":0,"nodeOutput":"docs/v5-space/experiments/E55-lens-prototype/imports/b-plain-Shop.ts:1 import { Shop } from './server.ts'          ^^^^ SyntaxError: The ","tscErrors":"error TS1484 ","esbuildShipsServer":"1","esbuildError":""}
- {"exp":"E-55","claim":24,"client":"b-plain-Shop","config":"plain","node":"v22.22.0","nodeRanServer":0,"nodeOutput":"docs/v5-space/experiments/E55-lens-prototype/imports/b-plain-Shop.ts:1 import { Shop } from './server.ts'          ^^^^ SyntaxError: The ","tscErrors":"","esbuildShipsServer":"0","esbuildError":""}
- {"exp":"E-55","claim":24,"client":"c-type-shop","config":"vms","node":"v22.22.0","nodeRanServer":0,"nodeOutput":"client ran shop ","tscErrors":"","esbuildShipsServer":"0","esbuildError":""}
- {"exp":"E-55","claim":24,"client":"c-type-shop","config":"plain","node":"v22.22.0","nodeRanServer":0,"nodeOutput":"client ran shop ","tscErrors":"","esbuildShipsServer":"0","esbuildError":""}
- {"exp":"E-55","claim":24,"client":"d-plain-shop","config":"vms","node":"v22.22.0","nodeRanServer":1,"nodeOutput":"SERVER MODULE RAN client ran shop ","tscErrors":"","esbuildShipsServer":"1","esbuildError":""}
- {"exp":"E-55","claim":24,"client":"d-plain-shop","config":"plain","node":"v22.22.0","nodeRanServer":1,"nodeOutput":"SERVER MODULE RAN client ran shop ","tscErrors":"","esbuildShipsServer":"0","esbuildError":""}
- {"exp":"E-55","claim":24,"client":"a-type-Shop","config":"vms","node":"v26.13.0","nodeRanServer":0,"nodeOutput":"client ran shop ","tscErrors":"","esbuildShipsServer":"0","esbuildError":""}
- {"exp":"E-55","claim":24,"client":"a-type-Shop","config":"plain","node":"v26.13.0","nodeRanServer":0,"nodeOutput":"client ran shop ","tscErrors":"","esbuildShipsServer":"0","esbuildError":""}
- {"exp":"E-55","claim":24,"client":"b-plain-Shop","config":"vms","node":"v26.13.0","nodeRanServer":0,"nodeOutput":"docs/v5-space/experiments/E55-lens-prototype/imports/b-plain-Shop.ts:1 import { Shop } from './server.ts'          ^^^^ SyntaxError: The ","tscErrors":"error TS1484 ","esbuildShipsServer":"1","esbuildError":""}
- {"exp":"E-55","claim":24,"client":"b-plain-Shop","config":"plain","node":"v26.13.0","nodeRanServer":0,"nodeOutput":"docs/v5-space/experiments/E55-lens-prototype/imports/b-plain-Shop.ts:1 import { Shop } from './server.ts'          ^^^^ SyntaxError: The ","tscErrors":"","esbuildShipsServer":"0","esbuildError":""}
- {"exp":"E-55","claim":24,"client":"c-type-shop","config":"vms","node":"v26.13.0","nodeRanServer":0,"nodeOutput":"client ran shop ","tscErrors":"","esbuildShipsServer":"0","esbuildError":""}
- {"exp":"E-55","claim":24,"client":"c-type-shop","config":"plain","node":"v26.13.0","nodeRanServer":0,"nodeOutput":"client ran shop ","tscErrors":"","esbuildShipsServer":"0","esbuildError":""}
- {"exp":"E-55","claim":24,"client":"d-plain-shop","config":"vms","node":"v26.13.0","nodeRanServer":1,"nodeOutput":"SERVER MODULE RAN client ran shop ","tscErrors":"","esbuildShipsServer":"1","esbuildError":""}
- {"exp":"E-55","claim":24,"client":"d-plain-shop","config":"plain","node":"v26.13.0","nodeRanServer":1,"nodeOutput":"SERVER MODULE RAN client ran shop ","tscErrors":"","esbuildShipsServer":"0","esbuildError":""}
- {"exp":"E-55","claim":24,"client":"a-type-Shop","config":"vms","node":"v22.22.0","nodeRanServer":0,"nodeOutput":"client ran shop ","tscErrors":"","esbuildShipsServer":"0","esbuildError":""}
- {"exp":"E-55","claim":24,"client":"a-type-Shop","config":"plain","node":"v22.22.0","nodeRanServer":0,"nodeOutput":"client ran shop ","tscErrors":"","esbuildShipsServer":"0","esbuildError":""}
- {"exp":"E-55","claim":24,"client":"b-plain-Shop","config":"vms","node":"v22.22.0","nodeRanServer":0,"nodeOutput":"docs/v5-space/experiments/E55-lens-prototype/imports/b-plain-Shop.ts:1 import { Shop } from './server.ts'          ^^^^ SyntaxError: The ","tscErrors":"error TS1484 ","esbuildShipsServer":"1","esbuildError":""}
- {"exp":"E-55","claim":24,"client":"b-plain-Shop","config":"plain","node":"v22.22.0","nodeRanServer":0,"nodeOutput":"docs/v5-space/experiments/E55-lens-prototype/imports/b-plain-Shop.ts:1 import { Shop } from './server.ts'          ^^^^ SyntaxError: The ","tscErrors":"","esbuildShipsServer":"0","esbuildError":""}
- {"exp":"E-55","claim":24,"client":"c-type-shop","config":"vms","node":"v22.22.0","nodeRanServer":0,"nodeOutput":"client ran shop ","tscErrors":"","esbuildShipsServer":"0","esbuildError":""}
- {"exp":"E-55","claim":24,"client":"c-type-shop","config":"plain","node":"v22.22.0","nodeRanServer":0,"nodeOutput":"client ran shop ","tscErrors":"","esbuildShipsServer":"0","esbuildError":""}
- {"exp":"E-55","claim":24,"client":"d-plain-shop","config":"vms","node":"v22.22.0","nodeRanServer":1,"nodeOutput":"SERVER MODULE RAN client ran shop ","tscErrors":"","esbuildShipsServer":"1","esbuildError":""}
- {"exp":"E-55","claim":24,"client":"d-plain-shop","config":"plain","node":"v22.22.0","nodeRanServer":1,"nodeOutput":"SERVER MODULE RAN client ran shop ","tscErrors":"","esbuildShipsServer":"0","esbuildError":""}
- {"exp":"E-55","claim":24,"client":"a-type-Shop","config":"vms","node":"v26.13.0","nodeRanServer":0,"nodeOutput":"client ran shop ","tscErrors":"","esbuildShipsServer":"0","esbuildError":""}
- {"exp":"E-55","claim":24,"client":"a-type-Shop","config":"plain","node":"v26.13.0","nodeRanServer":0,"nodeOutput":"client ran shop ","tscErrors":"","esbuildShipsServer":"0","esbuildError":""}
- {"exp":"E-55","claim":24,"client":"b-plain-Shop","config":"vms","node":"v26.13.0","nodeRanServer":0,"nodeOutput":"docs/v5-space/experiments/E55-lens-prototype/imports/b-plain-Shop.ts:1 import { Shop } from './server.ts'          ^^^^ SyntaxError: The ","tscErrors":"error TS1484 ","esbuildShipsServer":"1","esbuildError":""}
- {"exp":"E-55","claim":24,"client":"b-plain-Shop","config":"plain","node":"v26.13.0","nodeRanServer":0,"nodeOutput":"docs/v5-space/experiments/E55-lens-prototype/imports/b-plain-Shop.ts:1 import { Shop } from './server.ts'          ^^^^ SyntaxError: The ","tscErrors":"","esbuildShipsServer":"0","esbuildError":""}
- {"exp":"E-55","claim":24,"client":"c-type-shop","config":"vms","node":"v26.13.0","nodeRanServer":0,"nodeOutput":"client ran shop ","tscErrors":"","esbuildShipsServer":"0","esbuildError":""}
- {"exp":"E-55","claim":24,"client":"c-type-shop","config":"plain","node":"v26.13.0","nodeRanServer":0,"nodeOutput":"client ran shop ","tscErrors":"","esbuildShipsServer":"0","esbuildError":""}
- {"exp":"E-55","claim":24,"client":"d-plain-shop","config":"vms","node":"v26.13.0","nodeRanServer":1,"nodeOutput":"SERVER MODULE RAN client ran shop ","tscErrors":"","esbuildShipsServer":"1","esbuildError":""}
- {"exp":"E-55","claim":24,"client":"d-plain-shop","config":"plain","node":"v26.13.0","nodeRanServer":1,"nodeOutput":"SERVER MODULE RAN client ran shop ","tscErrors":"","esbuildShipsServer":"0","esbuildError":""}
## The review pass

### One verdict rule: the median of every run against the bar (first runs, the reviewer's rerun, the review pass)

| what | bar | runs | median | lowest to highest | every run | the median |
|---|---|---|---|---|---|---|
| claim 1: a step, keys spread, 1000 rows (ns) | 150 | 6 | 60.2 | 54.2 to 66.8 | 66.8, 60.7, 66.2, 54.2, 59.7, 58.6 | meets |
| claim 1: a step, keys spread, 100000 rows (ns) | 150 | 6 | 116 | 95 to 236 | 236, 132, 118, 112, 95, 113 | meets |
| claim 1: a step, keys spread, 1000000 rows (ns) | 150 | 7 | 205 | 162 to 222 | 188, 205, 210, 162, 222, 205, 178 | misses |
| claim 1: a step, one key, 1000 rows (ns) | 150 | 6 | 53.9 | 49.2 to 56.1 | 54.9, 56.1, 54.7, 49.2, 51.6, 53 | meets |
| claim 1: a step, one key, 100000 rows (ns) | 150 | 6 | 65 | 51.4 to 83.3 | 75.6, 69.4, 83.3, 51.4, 54.2, 60.5 | meets |
| claim 1: a step, one key, 1000000 rows (ns) | 150 | 7 | 73.2 | 66 to 99.2 | 99.2, 81.6, 78.3, 72.9, 73.2, 66, 68.5 | meets |
| claim 1: a kept verb over direct, 1000 rows (ns) | 200 | 6 | 8.2 | 0.1 to 11.5 | 0.1, 10.1, 8.4, 11.5, 6.8, 8 | meets |
| claim 1: a kept verb over direct, 100000 rows (ns) | 200 | 6 | 8 | -4 to 13 | 7.1, -3.2, -4, 8.9, 13, 10.7 | meets |
| claim 1: a kept verb over direct, 1000000 rows (ns) | 200 | 7 | -7 | -63 to 23.6 | -5.8, -2.3, 23.6, -11.5, -7, -63, -14 | meets |
| claim 1: at() over direct, keys spread, 1000 rows (ns) | 100 | 6 | 9.8 | 3.6 to 15.1 | 4.6, 7.2, 12.3, 3.6, 15.1, 13.9 | meets |
| claim 1: at() over direct, keys spread, 100000 rows (ns) | 100 | 6 | -19.5 | -61 to 32.8 | -29.5, -9.5, -33.8, -61, 16.9, 32.8 | meets |
| claim 1: at() over direct, keys spread, 1000000 rows (ns) | 100 | 7 | -47.9 | -78.6 to 1.9 | 1.9, -2.6, -16, -53.1, -66, -47.9, -78.6 | meets |
| claim 1: at() over direct, one key, 1000 rows (ns) | 100 | 6 | 8.6 | 3.4 to 14.2 | 3.4, 5.4, 10.9, 8, 14.2, 9.1 | meets |
| claim 1: at() over direct, one key, 100000 rows (ns) | 100 | 6 | 24.4 | 11.5 to 33.5 | 29.5, 24.8, 11.5, 24, 23.8, 33.5 | meets |
| claim 1: at() over direct, one key, 1000000 rows (ns) | 100 | 7 | 81.9 | 54.1 to 154 | 69.6, 154, 60.7, 81.9, 106, 54.1, 106 | meets |
| claim 3: steps over direct, 10000 rows (ns) | 1000 | 6 | 311 | 176 to 403 | 403, 176, 308, 362, 310, 312 | meets |
| claim 3: steps over direct, 100000 rows (ns) | 1000 | 7 | 474 | 309 to 734 | 309, 474, 585, 734, 544, 402, 337 | meets |
| claim 3: steps over direct, 1000000 rows (ns) | 1000 | 6 | 340 | 225 to 499 | 420, 225, 252, 320, 359, 499 | meets |
| claim 3: kept over direct, 10000 rows (ns) | 300 | 6 | 163 | -18.5 to 227 | 227, -18.5, 144, 131, 183, 199 | meets |
| claim 3: kept over direct, 100000 rows (ns) | 300 | 7 | 165 | 40.3 to 306 | 40.3, 259, 207, 165, 306, 152, 144 | meets |
| claim 3: kept over direct, 1000000 rows (ns) | 300 | 6 | 276 | -25.7 to 424 | 240, -25.7, 313, 424, 179, 333 | meets |
| claim 8: K = 10,000 over K = 0 (ratio), every run | 1.3 | 15 | 1.25 | 1.09 to 1.52 | 1.20, 1.25, 1.36, 1.26, 1.14, 1.09, 1.12, 1.18, 1.52, 1.34, 1.41, 1.21, 1.36, 1.40, 1.24 | meets |
| claim 8: the first build only | 1.3 | 8 | 1.19 | 1.09 to 1.36 | 1.20, 1.25, 1.36, 1.26, 1.14, 1.09, 1.12, 1.18 | meets |
| claim 8: the changed build only | 1.3 | 7 | 1.36 | 1.21 to 1.52 | 1.52, 1.34, 1.41, 1.21, 1.36, 1.40, 1.24 | misses |

claim 8, the first build, ns per write: K = 0: 1243 to 1545 (median 1394); K = 10,000: 1573 to 1862 (median 1659)

claim 8, the changed build, ns per write: K = 0: 1230 to 1648 (median 1280); K = 10,000: 1625 to 2502 (median 1727)

### Claim 10, the ways interleaved round by round (ns per write; each cell: the median of 9 rounds; "runs" is the range of that median over the runs; "rounds" is the lowest and highest single round of any run)

| difference, inside one round | runs: median | each run | rounds: lowest to highest |
|---|---|---|---|
| noise_noneB_minus_noneA | -7.6 to 2.2 | -1, 2.2, -7.6 | -281 to 420 |
| dataSink_over_none | 63 to 122 | 122, 67.9, 63 | -160 to 525 |
| nothing_over_none | 92.4 to 198 | 198, 92.4, 112 | -136 to 875 |
| lens_over_dataSink | 31 to 103 | 103, 55.1, 31 | -460 to 799 |
| changes_over_nothing | -39.2 to 31.7 | -39.2, 11.3, 31.7 | -767 to 418 |
| frozen_over_changes | 163 to 220 | 163, 220, 211 | -162 to 736 |
| now_over_nothing | -33.3 to 91.3 | -33.3, -10.3, 91.3 | -704 to 363 |
| recs_over_nothing | 166 to 216 | 216, 210, 166 | -552 to 445 |
| data_bare_tap_over_none | 126 to 168 | 126, 167, 168 | -318 to 820 |
| data_param_over_bare | 1525 to 1788 | 1788, 1662, 1525 | 937 to 2461 |

| way | ns per write: median of 9 rounds, range over the runs |
|---|---|
| none A | 825 to 875 |
| none B | 848 to 859 |
| bare data sink | 924 to 934 |
| tap reads nothing | 972 to 1037 |
| tap reads changes+prev | 965 to 996 |
| tap reads changes+prev, frozen | 1146 to 1245 |
| tap reads now | 1000 to 1035 |
| tap reads recs() | 1151 to 1177 |
| data none | 1895 to 2017 |
| data tap(() => …) | 1982 to 2185 |
| data tap((rec) => …) | 3748 to 3981 |

claim 20 again with lens.get(): 100000 GETs, 0 SUBs, 0 selections, 0 rows kept, 0 answers behind the position seen, 45.1 µs a read | 100000 GETs, 0 SUBs, 0 selections, 0 rows kept, 0 answers behind the position seen, 43.4 µs a read | 100000 GETs, 0 SUBs, 0 selections, 0 rows kept, 0 answers behind the position seen, 43.5 µs a read

### The seeded runs on the changed prototype (raw lines)

```json
{"exp":"E-55","node":"v22.22.0","claim":4,"bench":"callspace","cases":47,"passed":47,"failing":[]}
```
```json
{"exp":"E-55","node":"v22.22.0","claim":7,"bench":"picture-then-changes","seeds":1000,"sinks":93326,"doubled":0,"missed":0,"unequal":0,"propUnequal":0,"firstsNotEmpty":0,"failedSeeds":[]}
```
```json
{"exp":"E-55","node":"v22.22.0","claim":14,"bench":"collector-adversary","mutate":"","target-only":{"programs":3,"collectorSeeds":1000,"distinctResultsPerProgram":1,"distinctLeakyRowsPerProgram":33.666666666666664,"linksEndedByNet":58178,"upstreamSubsRange":[6,10],"distinctGetHereOrTripPatternsPerProgram":1,"getsServedHere":556000,"getsThatTrip":1604000,"distinctClientSubCountsPerProgram":3},"shared":{"programs":3,"collectorSeeds":1000,"distinctResultsPerProgram":432.6666666666667,"distinctLeakyRowsPerProgram":8,"linksEndedByNet":57679,"upstreamSubsRange":[6,10],"distinctGetHereOrTripPatternsPerProgram":1,"getsServedHere":435000,"getsThatTrip":1725000,"distinctClientSubCountsPerProgram":3}}
```
```json
{"exp":"E-55","node":"v22.22.0","claim":14,"bench":"collector-adversary","mutate":"weakread","target-only":{"programs":3,"collectorSeeds":1000,"distinctResultsPerProgram":9.666666666666666,"distinctLeakyRowsPerProgram":33.666666666666664,"linksEndedByNet":58178,"upstreamSubsRange":[6,10],"distinctGetHereOrTripPatternsPerProgram":9.666666666666666,"getsServedHere":1003642,"getsThatTrip":1156358,"distinctClientSubCountsPerProgram":3},"shared":{"programs":3,"collectorSeeds":1000,"distinctResultsPerProgram":475,"distinctLeakyRowsPerProgram":8,"linksEndedByNet":57679,"upstreamSubsRange":[6,10],"distinctGetHereOrTripPatternsPerProgram":13.666666666666666,"getsServedHere":944169,"getsThatTrip":1215831,"distinctClientSubCountsPerProgram":3}}
```
```json
{"exp":"E-55","node":"v22.22.0","claim":26,"bench":"view-lifetimes","mutate":"","seeds":1000,"sinks":59958,"calledAfterEnd":0,"viewsLeft":0,"selsLeft":0,"firstMissing":0,"byHow":{"collector":14457,"scope":17569,"link.close":7151,"close":20781},"failedSeeds":[]}
```
```json
{"exp":"E-55","node":"v22.22.0","claim":26,"bench":"view-lifetimes","mutate":"viewleak","seeds":300,"sinks":18041,"calledAfterEnd":22539,"viewsLeft":8178,"selsLeft":0,"firstMissing":0,"byHow":{"collector":4295,"scope":5355,"link.close":2200,"close":6191},"failedSeeds":[1,2,3,4,5,6,7,8,9,10]}
```
```json
{"exp":"E-55","node":"v22.22.0","claim":17,"bench":"commute","seeds":1000,"chainPositions":3000,"badRunsKeyedClient":239,"badRunsOrderKept":0,"badOrderedChains":[],"chains":438,"failingChains":99,"failing":[{"chain":"reverse","runs":43,"bad":43,"herePositions":[1]},{"chain":"za","runs":57,"bad":32,"herePositions":[1]},{"chain":"top","runs":56,"bad":16,"herePositions":[1]},{"chain":"az.az","runs":9,"bad":7,"herePositions":[2]},{"chain":"gte.az","runs":5,"bad":5,"herePositions":[2]},{"chain":"between.az","runs":5,"bad":5,"herePositions":[2]},{"chain":"lt.az","runs":5,"bad":4,"herePositions":[2]},{"chain":"az.top","runs":7,"bad":4,"herePositions":[2]},{"chain":"lt.reverse","runs":3,"bad":3,"herePositions":[2]},{"chain":"top.az","runs":4,"bad":3,"herePositions":[2]},{"chain":"za.za","runs":4,"bad":3,"herePositions":[2]},{"chain":"lte.az.reverse","runs":3,"bad":3,"herePositions":[3]},{"chain":"reverse.az","runs":3,"bad":3,"herePositions":[2]},{"chain":"az.top.az","runs":3,"bad":3,"herePositions":[3]},{"chain":"lt.top","runs":3,"bad":2,"herePositions":[2]},{"chain":"reverse.reverse","runs":2,"bad":2,"herePositions":[2]},{"chain":"reverse.za","runs":3,"bad":2,"herePositions":[2]},{"chain":"limit.az","runs":6,"bad":2,"herePositions":[2]},{"chain":"top.top.reverse","runs":2,"bad":2,"herePositions":[3]},{"chain":"between.az.az","runs":3,"bad":2,"herePositions":[3]},{"chain":"lte.reverse","runs":2,"bad":2,"herePositions":[2]},{"chain":"gte.top","runs":2,"bad":2,"herePositions":[2]},{"chain":"lt.gte.az","runs":2,"bad":2,"herePositions":[3]},{"chain":"reverse.top.az","runs":2,"bad":2,"herePositions":[3]},{"chain":"top.az.az","runs":3,"bad":2,"herePositions":[3]},{"chain":"az.reverse","runs":2,"bad":2,"herePositions":[2]},{"chain":"az.za.top","runs":2,"bad":2,"herePositions":[3]},{"chain":"between.reverse","runs":2,"bad":2,"herePositions":[2]},{"chain":"lte.az","runs":2,"bad":2,"herePositions":[2]},{"chain":"between.za","runs":2,"bad":2,"herePositions":[2]},{"chain":"gt.reverse","runs":2,"bad":2,"herePositions":[2]},{"chain":"reverse.top","runs":2,"bad":2,"herePositions":[2]},{"chain":"az.limit","runs":2,"bad":2,"herePositions":[2]},{"chain":"az.between.az","runs":3,"bad":2,"herePositions":[3]},{"chain":"lt.za.reverse","runs":2,"bad":1,"herePositions":[3]},{"chain":"lt.za","runs":2,"bad":1,"herePositions":[2]},{"chain":"gt.za.za","runs":1,"bad":1,"herePositions":[3]},{"chain":"gt.top","runs":2,"bad":1,"herePositions":[2]},{"chain":"gt.az","runs":6,"bad":1,"herePositions":[2]},{"chain":"gt.lte.reverse","runs":1,"bad":1,"herePositions":[3]}],"passingSample":["gte.lt","gte.gt.gt","lt.lt.length","lt.length","gte.az.gte","min","max","gte.avg","lt.max","gte.lte.between","lt.gte.reverse","gt.sum","gt.reverse.gt","lt.limit.lt","gt.length","lt.az.max","lt.lte","gt.gte.top","lt.lt.min","gt.lt","lt.top.gte","gt.az.sum","avg","reverse.min","reverse.reverse.gt","reverse.gte","reverse.reverse.min","gt.reverse.lt","gt.min","gt.za.lte"]}
```
```json
{"exp":"E-55","node":"v22.22.0","claim":7,"bench":"net-reconnect","seeds":1000,"steps":43794,"sinks":11865,"disconnects":4337,"resumes":5968,"pictures":4743,"doubled":0,"missed":0,"phantom":0,"unequal":0,"failedSeeds":[]}
```
```json
{"exp":"E-55","node":"v22.22.0","claim":9,"bench":"net-share","links":2000,"writes":200,"serverSubs":1,"serverEncodes":200,"framesToThisClient":200,"decodesHere":200,"textBuildsHere":200,"everyTargetCurrent":true}
```
```json
{"exp":"E-55","node":"v22.22.0","claim":9,"bench":"share","links":2000,"counts":{"upstreamSubs":1,"framesDecoded":100,"writes":100,"foldsInCache":100,"textBuilds":100,"deliveries":100000,"selections":1,"allTargetsCurrent":true},"unsubBeforeLinger":0,"lingerTimers":1,"unsubAfterLinger":1,"selectionsAfter":0,"cacheRowsAfter":0}
```
```json
{"exp":"E-55","node":"v22.22.0","claim":18,"bench":"leader","servers":3,"freshTable":{"calls":1000,"clientTrips":1000,"serverForwards":0,"commits":1000,"redirects":0,"tripsPerCall":1,"commitsPerCall":1},"afterMoveFirstCall":{"calls":30,"clientTrips":60,"redirects":30,"serverForwards":0,"commits":30},"afterMoveNextCall":{"calls":30,"clientTrips":30,"redirects":0,"serverForwards":0,"commits":30},"noPath":{"calls":3000,"clientTrips":3000,"serverForwards":2014,"extraTripShare":0.671,"expected":0.667,"commits":3000},"badPath":{"calls":202,"refusedBadPath":202,"commits":0}}
```
```json
{"exp":"E-55","node":"v22.22.0","claim":18,"bench":"leader","servers":5,"freshTable":{"calls":1000,"clientTrips":1000,"serverForwards":0,"commits":1000,"redirects":0,"tripsPerCall":1,"commitsPerCall":1},"afterMoveFirstCall":{"calls":30,"clientTrips":60,"redirects":30,"serverForwards":0,"commits":30},"afterMoveNextCall":{"calls":30,"clientTrips":30,"redirects":0,"serverForwards":0,"commits":30},"noPath":{"calls":3000,"clientTrips":3000,"serverForwards":2386,"extraTripShare":0.795,"expected":0.8,"commits":3000},"badPath":{"calls":202,"refusedBadPath":202,"commits":0}}
```
```json
{"exp":"E-55","node":"v22.22.0","claim":21,"bench":"marks-sim-2","cap":8,"records":60,"as-written":{"seeds":1000,"badSeeds":998,"lostOutputs":7262,"doubledOutputs":0,"notCleanAtEnd":0,"maxWaiting":8,"applied":38372,"refused":4286,"skipped":85789,"gap":7248,"backpressure":56317,"blockedDrops":0,"lostInFlight":11792,"lostThenDelivered":1136,"moves":27302,"crashes":14434,"twins":1936,"restarts":19530},"block":{"seeds":1000,"badSeeds":0,"lostOutputs":0,"doubledOutputs":0,"notCleanAtEnd":0,"maxWaiting":8,"applied":54018,"refused":5982,"skipped":85121,"gap":1101,"backpressure":28878,"blockedDrops":106227,"lostInFlight":11033,"lostThenDelivered":1121,"moves":27686,"crashes":14419,"twins":1568,"restarts":18962},"pace":{"seeds":1000,"badSeeds":0,"lostOutputs":0,"doubledOutputs":0,"notCleanAtEnd":0,"maxWaiting":8,"applied":54018,"refused":5982,"skipped":96951,"gap":13629,"backpressure":0,"blockedDrops":0,"lostInFlight":16924,"lostThenDelivered":1759,"moves":27578,"crashes":14405,"twins":1647,"restarts":18939},"pace-nogap":{"seeds":1000,"badSeeds":756,"lostOutputs":1497,"doubledOutputs":0,"notCleanAtEnd":0,"maxWaiting":8,"applied":52341,"refused":5806,"skipped":89374,"gap":0,"backpressure":0,"blockedDrops":0,"lostInFlight":14012,"lostThenDelivered":1376,"moves":27401,"crashes":14357,"twins":1881,"restarts":19298},"nomarks":{"seeds":1000,"badSeeds":1000,"lostOutputs":0,"doubledOutputs":7856,"notCleanAtEnd":0,"maxWaiting":8,"applied":117757,"refused":13176,"skipped":120595,"gap":23678,"backpressure":0,"blockedDrops":0,"lostInFlight":25202,"lostThenDelivered":2876,"moves":28166,"crashes":14413,"twins":1030,"restarts":17491}}
```
```json
{"exp":"E-55","node":"v22.22.0","claim":21,"bench":"marks-sim-2","cap":512,"records":4000,"as-written":{"seeds":100,"badSeeds":100,"lostOutputs":800,"doubledOutputs":0,"notCleanAtEnd":0,"maxWaiting":512,"applied":196183,"refused":21884,"skipped":509191,"gap":1517220,"backpressure":75316304,"blockedDrops":0,"lostInFlight":37960075,"lostThenDelivered":1058291,"moves":193182,"crashes":96241,"twins":100,"restarts":96703},"block":{"seeds":100,"badSeeds":0,"lostOutputs":0,"doubledOutputs":0,"notCleanAtEnd":0,"maxWaiting":512,"applied":360044,"refused":39956,"skipped":513270,"gap":1431385,"backpressure":222407,"blockedDrops":79019395,"lostInFlight":33777907,"lostThenDelivered":940352,"moves":193146,"crashes":96199,"twins":100,"restarts":96948},"pace":{"seeds":100,"badSeeds":0,"lostOutputs":0,"doubledOutputs":0,"notCleanAtEnd":0,"maxWaiting":512,"applied":360044,"refused":39956,"skipped":473695,"gap":1521049,"backpressure":0,"blockedDrops":0,"lostInFlight":38321419,"lostThenDelivered":1065588,"moves":193334,"crashes":96488,"twins":100,"restarts":96788},"pace-nogap":{"seeds":100,"badSeeds":100,"lostOutputs":800,"doubledOutputs":0,"notCleanAtEnd":0,"maxWaiting":512,"applied":25839,"refused":2826,"skipped":457124,"gap":0,"backpressure":0,"blockedDrops":0,"lostInFlight":3925254,"lostThenDelivered":113277,"moves":189143,"crashes":95270,"twins":4036,"restarts":103571},"nomarks":{"seeds":100,"badSeeds":100,"lostOutputs":0,"doubledOutputs":800,"notCleanAtEnd":0,"maxWaiting":512,"applied":543977,"refused":62659,"skipped":367988,"gap":1524586,"backpressure":0,"blockedDrops":0,"lostInFlight":38283917,"lostThenDelivered":1063434,"moves":193341,"crashes":96132,"twins":100,"restarts":96432}}
```
```json
{"exp":"E-55","node":"v22.22.0","claim":7,"bench":"picture-then-changes","seeds":300,"sinks":28117,"doubled":1396,"missed":1113,"unequal":0,"propUnequal":0,"firstsNotEmpty":0,"failedSeeds":[1,2,3,4,5,6,7,8,9,10]}
```
```json
{"exp":"E-55","node":"v22.22.0","claim":7,"bench":"picture-then-changes","seeds":300,"sinks":27902,"doubled":514,"missed":392,"unequal":204,"propUnequal":0,"firstsNotEmpty":0,"failedSeeds":[1,2,3,4,5,6,7,9,10,11]}
```
```json
{"exp":"E-55","node":"v22.22.0","claim":7,"bench":"picture-then-changes","seeds":300,"sinks":28428,"doubled":0,"missed":0,"unequal":536,"propUnequal":83,"firstsNotEmpty":0,"failedSeeds":[32,112,118,130,228]}
```
```json
{"exp":"E-55","node":"v22.22.0","claim":7,"bench":"net-reconnect","seeds":100,"steps":4441,"sinks":1205,"disconnects":418,"resumes":651,"pictures":435,"doubled":0,"missed":0,"phantom":0,"unequal":999,"failedSeeds":[1,4,5,7,8,15,17,23,24,28]}
```
```json
{"exp":"E-55","node":"v22.22.0","claim":7,"bench":"net-reconnect","seeds":100,"steps":4441,"sinks":1205,"disconnects":418,"resumes":610,"pictures":476,"doubled":0,"missed":0,"phantom":697,"unequal":0,"failedSeeds":[1,2,3,5,6,8,9,10,11,13]}
```
