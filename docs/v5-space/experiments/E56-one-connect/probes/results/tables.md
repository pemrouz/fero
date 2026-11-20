### Probe 2: a for-await loop 10 times slower than the writes (10,000 commits a second for 5 s)

| mode | link on | runs | achieved writes/s | turns | commits the loop saw | commits per turn | waiting at the end | most waiting | heap growth MB | bytes per waiting commit | waiting grows a second |
|---|---|---|---|---|---|---|---|---|---|---|---|
| merge | one row | 3 | 9998 to 9999 | 4314 to 4367 | 49990 to 49996 | 11.4 to 11.6 | 1 | 1 | 0.3 to 0.4 | n/a |  |
| merge | the whole resource (1,000 rows) | 3 | 9998 to 9999 | 4322 to 4395 | 49991 to 49995 | 11.4 to 11.6 | 5 to 9 | 27 to 50 | 0.3 | n/a |  |
| every | one row | 3 | 9998 | 4363 to 4413 | 4362 to 4412 | 1 | 45588 to 45638 | 45588 to 45638 | 16.1 | 353 | 9116 to 9127 |
| every | the whole resource (1,000 rows) | 3 | 9999 | 4373 to 4388 | 4372 to 4387 | 1 | 45613 to 45628 | 45613 to 45628 | 17.1 | 375 | 9124 to 9127 |

### Probe 2: ns per commit, one link on the whole resource (3 runs; each run the median of 7 interleaved rounds)

| way | ns a commit | over no link (inside each round) |
|---|---|---|
| none | 930.7 to 975.5 |  |
| callback | 1086.5 to 1161.6 | 160.9 to 189 |
| callback reads changes and prev | 1119 to 1147.1 | 157.2 to 192.2 |
| every-burst100 | 1209.2 to 1279.2 | 311.1 to 336.4 |
| merge-burst100 | 1308.3 to 1393.5 | 357.7 to 445.6 |
| every-pingpong | 1762.5 to 1829.9 |  |
| merge-pingpong | 1918.1 to 1981.5 |  |
| none-pingpong | 1010.9 to 1095.5 |  |
| for await (every, bursts of 100), over the callback | | 116.1 to 136.7 |
| for await (merged, bursts of 100), over the callback | | 165.9 to 240.8 |
| for await one commit at a time (every), over the writer's own await | | 706.8 to 788.9 |
| for await one commit at a time (merged), over the writer's own await | | 874.1 to 910 |

### Probe 3: what reading the commit costs, 1 change a commit (3 runs; each run the median of 9 interleaved rounds)

| way | ns a commit | over no link | over a callback that reads nothing |
|---|---|---|---|
| none | 895.6 to 996.4 |  |  |
| nothing | 1042.7 to 1154.9 | 96.4 to 139.5 |  |
| recs | 1039.4 to 1153.4 | 91.5 to 149 | -69.6 to 29 |
| changes | 1020.8 to 1115.1 | 55.5 to 122.1 | -57.1 to 2.9 |
| diff | 1033.6 to 1132.2 | 91.6 to 116.9 | -64.9 to 20.5 |
| leafdiff | 1035.3 to 1104.9 | 95.8 to 130.6 | -80.2 to 7 |
| text | 1014.7 to 1111.2 | 79.5 to 105.8 | -23.4 to 23.5 |
| diff over recs | | | -28.5 to 12.7 |

The same work alone, no writes in the timed loop: ns per change over 100000 captured changes (3 runs; each the median of 9 interleaved rounds)

| way | ns a change |
|---|---|
| read prev | 8.5 to 11.1 |
| build a diff | 21 to 22.4 |
| build a field diff | 30.5 to 35.3 |
| build the records | 137.6 to 170.3 |
| records as JSON | 334.4 to 376.9 |

### Probe 3: what reading the commit costs, 10 changes a commit (3 runs; each run the median of 9 interleaved rounds)

| way | ns a commit | over no link | over a callback that reads nothing |
|---|---|---|---|
| none | 4378.3 to 4441.1 |  |  |
| nothing | 4434.9 to 4740.2 | 126.3 to 343.1 |  |
| recs | 4562.1 to 4916.1 | 95.1 to 399.9 | -117.8 to 177.3 |
| changes | 4626.6 to 4655.6 | 8.5 to 215.7 | -94.1 to 112.3 |
| diff | 4465 to 4709.6 | 90.5 to 115.4 | -136.8 to 52.3 |
| leafdiff | 4536.1 to 4734.9 | 42.6 to 205.2 | -239.1 to 113.5 |
| text | 4483.6 to 4779.3 | 163.6 to 224.6 | -82.1 to 46.5 |
| diff over recs | | | -164.1 to 11 |

The same work alone, no writes in the timed loop: ns per change over 1000000 captured changes (3 runs; each the median of 9 interleaved rounds)

| way | ns a change |
|---|---|
| read prev | 8.2 to 11.5 |
| build a diff | 28.1 to 29.2 |
| build a field diff | 50.3 to 59 |
| build the records | 155.1 to 164.2 |
| records as JSON | 278.6 to 289.2 |

### Probe 4b: what { signal } and { until } cost a link (3 runs; each run the median of 7 interleaved rounds; ns a link)

One signal shared by n links, alone (no fero): a listener per link, against one listener per signal and a Set of its links.

| links on one signal | a listener per link: add | its remove | one listener and a Set: add | its remove |
|---|---|---|---|---|
| 10 | 4236.9 to 6516.5 | 1447.5 to 1601.3 | 1014 to 1117.7 | 345.5 to 375 |
| 100 | 5149.5 to 5242.4 | 650.2 to 659.9 | 234.6 to 246.3 | 127.1 to 131.3 |
| 1,000 | 1932.4 to 7223.3 | 289.8 to 498.6 | 114 to 123.5 | 54.2 to 64.3 |
| 10,000 | 18782.2 to 19164.9 | 354.5 to 391.4 | 147.6 to 160.7 | 69.2 to 71.1 |

The prototype (a listener per link, as built): n links on one row of a server, connect() then disconnect(), ns a link for both.

| links | no end option | { signal } (one shared) | { until } (one socket-like thing) | signal over none | until over none |
|---|---|---|---|---|---|
| 10 | 4621.8 to 4812.4 | 9413.5 to 11313.1 | 5138.5 to 5711.9 | 4485.5 to 6309.3 | 389 to 592.5 |
| 100 | 2561.5 to 3508.2 | 6590.1 to 6950.4 | 5359.9 to 6833.1 | 3399.8 to 4088.6 | 2604.6 to 3123.3 |
| 1,000 | 569.6 to 630.7 | 3348.7 to 3587.4 | 2459 to 5298.8 | 2718 to 2986.1 | 1939.8 to 4397.1 |
| 10,000 | 802.6 to 876.7 | 26180.2 to 28452.4 | 22675.4 to 24562.5 | 25308.1 to 27656.4 | 21872.8 to 23690.4 |
