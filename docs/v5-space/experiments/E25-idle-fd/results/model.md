# E-25 (a): idle frames per second at n = 100 (placement model, seed 1)

Settings: n = 100 members, copies 3, random placement, leaders spread; tick and ping 500 ms; controller session 500 ms; Kafka fetch wait 500 ms and KRaft broker heartbeat 2000 ms; OBJ lease 2000 ms. Resources per project: 20.

| candidate | resources | groups | idle scheme | idle frames/s, all members | per member (sent) | linked member pairs | without quiet groups: heartbeat messages/s | frames/s coalesced (500 ms tick) | coalesced at a 100 ms tick | object-store PUTs/s |
|---|---|---|---|---|---|---|---|---|---|---|
| MIN, RUST, MIN-TS, LEAN, SRV, EMB-V8, SIDE | 1000 | 1000 | pings | 8,904 | 89 | 2226 | 8,000 | 7,244 | 36,220 | 0 |
| DRAFT | 1000 | 1000 | pings | 8,980 | 90 | 2245 | 8,000 | 7,208 | 36,040 | 0 |
| MIN-P (16 groups per project) | 1000 | 800 | pings | 7,616 | 76 | 1904 | 6,400 | 5,832 | 29,160 | 0 |
| CELL (16 cells per resource) | 1000 | 16000 | pings | 19,796 | 198 | 4949 | 128,000 | 38,004 | 190,020 | 0 |
| LANE (64 lanes per project) | 1000 | 3200 | pings | 16,976 | 170 | 4244 | 25,600 | 18,672 | 93,360 | 0 |
| SPLIT (1 range per resource at rest) | 1000 | 1000 | pings | 9,056 | 91 | 2264 | 8,000 | 7,272 | 36,360 | 0 |
| RLOG (groups on log members) | 1000 | 1000 | pings | 9,020 | 90 | 2255 | 8,000 | 7,304 | 36,520 | 0 |
| ISR (1 partition per resource) | 1000 | 1000 | ctrl+fetch | 7,288 | 73 | 2249 | 8,000 | 7,188 | 35,940 | 0 |
| SLOG (log groups, sessions to a controller) | 1000 | 1000 | ctrl | 400 | 4 | 2261 | 8,000 | 7,216 | 36,080 | 0 |
| OBJ (leases by conditional PUT) | 1000 | 1000 | obj | 0 | 0 | 2257 | 8,000 | 7,232 | 36,160 | 500 |
| MIN, RUST, MIN-TS, LEAN, SRV, EMB-V8, SIDE | 10000 | 10000 | pings | 19,756 | 198 | 4939 | 80,000 | 34,332 | 171,660 | 0 |
| DRAFT | 10000 | 10000 | pings | 19,768 | 198 | 4942 | 80,000 | 34,488 | 172,440 | 0 |
| MIN-P (16 groups per project) | 10000 | 8000 | pings | 19,616 | 196 | 4904 | 64,000 | 31,672 | 158,360 | 0 |
| CELL (16 cells per resource) | 10000 | 160000 | pings | 19,800 | 198 | 4950 | 1,280,000 | 39,600 | 198,000 | 0 |
| LANE (64 lanes per project) | 10000 | 32000 | pings | 19,800 | 198 | 4950 | 256,000 | 39,564 | 197,820 | 0 |
| SPLIT (1 range per resource at rest) | 10000 | 10000 | pings | 19,744 | 197 | 4936 | 80,000 | 34,212 | 171,060 | 0 |
| RLOG (groups on log members) | 10000 | 10000 | pings | 19,752 | 198 | 4938 | 80,000 | 34,180 | 170,900 | 0 |
| ISR (1 partition per resource) | 10000 | 10000 | ctrl+fetch | 34,456 | 345 | 4943 | 80,000 | 34,356 | 171,780 | 0 |
| SLOG (log groups, sessions to a controller) | 10000 | 10000 | ctrl | 400 | 4 | 4942 | 80,000 | 34,440 | 172,200 | 0 |
| OBJ (leases by conditional PUT) | 10000 | 10000 | obj | 0 | 0 | 4937 | 80,000 | 34,264 | 171,320 | 5,000 |
| MIN, RUST, MIN-TS, LEAN, SRV, EMB-V8, SIDE | 100000 | 100000 | pings | 19,800 | 198 | 4950 | 800,000 | 39,600 | 198,000 | 0 |
| DRAFT | 100000 | 100000 | pings | 19,800 | 198 | 4950 | 800,000 | 39,600 | 198,000 | 0 |
| MIN-P (16 groups per project) | 100000 | 80000 | pings | 19,800 | 198 | 4950 | 640,000 | 39,600 | 198,000 | 0 |
| CELL (16 cells per resource) | 100000 | 1600000 | pings | 19,800 | 198 | 4950 | 12,800,000 | 39,600 | 198,000 | 0 |
| LANE (64 lanes per project) | 100000 | 320000 | pings | 19,800 | 198 | 4950 | 2,560,000 | 39,600 | 198,000 | 0 |
| SPLIT (1 range per resource at rest) | 100000 | 100000 | pings | 19,800 | 198 | 4950 | 800,000 | 39,600 | 198,000 | 0 |
| RLOG (groups on log members) | 100000 | 100000 | pings | 19,800 | 198 | 4950 | 800,000 | 39,600 | 198,000 | 0 |
| ISR (1 partition per resource) | 100000 | 100000 | ctrl+fetch | 39,700 | 397 | 4950 | 800,000 | 39,600 | 198,000 | 0 |
| SLOG (log groups, sessions to a controller) | 100000 | 100000 | ctrl | 400 | 4 | 4950 | 800,000 | 39,600 | 198,000 | 0 |
| OBJ (leases by conditional PUT) | 100000 | 100000 | obj | 0 | 0 | 4950 | 800,000 | 39,600 | 198,000 | 50,000 |

## Per-pair pings as n grows (full mesh, 500 ms)

| n | frames/s, all | per member |
|---|---|---|
| 3 | 12 | 4 |
| 10 | 180 | 18 |
| 30 | 1,740 | 58 |
| 100 | 19,800 | 198 |
| 101 | 20,200 | 200 |
| 200 | 79,600 | 398 |
| 300 | 179,400 | 598 |
| 1000 | 1,998,000 | 1,998 |

With a bound of k linked peers per member (one more mechanism: placement keeps each member's groups within k peers), frames/s = n x k x 2: k = 32 gives 6,400 at n = 100 and 64,000 at n = 1,000.
