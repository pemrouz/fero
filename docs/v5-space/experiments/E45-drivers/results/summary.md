**etcd**
```
# E-45 etcd: 2026-11-06T21:18:47Z, node v22.22.0, data 63fea66, 4 vCPU, loadavg 3.73 4.36 4.87 5/182 19017
# host: host.ts etcd --listen 127.0.0.1:12390
# tool: sh -c 
## put-1c
  Requests/sec:	919.528271367042
  99% in 0.005730123 secs.
## put-1000c
  Requests/sec:	3273.0348087441744
  99% in 0.616390835 secs.
## range-l-1c
  Requests/sec:	1567.659429274804
  99% in 0.004871132 secs.
## range-l-1000c
  Requests/sec:	4131.558258025073
  99% in 0.395479425 secs.
## range-s-1c
  Requests/sec:	2692.2477587306635
  99% in 0.004481058 secs.
## range-s-1000c
  Requests/sec:	10092.985851020614
  99% in 0.148625644 secs.
## txn-put-1c
  Requests/sec:	1762.6737818098477
  99% in 0.00419124 secs.
## txn-put-1000c
  Requests/sec:	3914.8185591212764
  99% in 0.407754126 secs.
## lease-keepalive-1000c
  Requests/sec:	2823.339090808752
  99% in 0.476242965 secs.
## stm-1c
  Requests/sec:	569.672092675997
  99% in 0.006354576 secs.
## stm-1000c
  Requests/sec:	1741.827005638267
  99% in 0.740242446 secs.
# tool exit code 0, wall 12.525653627 s
summary (SIGTERM): [12.6 s real, 3.531 s virtual, 119682 events, 36019 verbs] conns=0 in=0B out=0B 
    ops{put=6001 range-l=6000 range-s=9009 txn=9009 lease-grant=1000 lease-keepalive=5000 txn-cas=3009} errors{} cpu=10.87s rss=477MB
```

**js**
```
# E-45 js: 2026-11-06T21:18:44Z, node v22.22.0, data 63fea66, 4 vCPU, loadavg 3.73 4.36 4.87 5/180 18914
# host: host.ts nats --listen 127.0.0.1:14290
# tool: sh -c 
NATS JetStream synchronous publisher stats: 3,249 msgs/sec ~ 317 KiB/sec ~ min: 104.36us ~ avg: 307.30us ~ max: 6,367.18us ~ P50: 256.51us ~ P90: 410.32us ~ P99: 1,333.83us ~ P99.9: 6,367.18us
 NATS JetStream synchronous publisher aggregated stats: 6,352 msgs/sec ~ 620 KiB/sec
NATS JetStream asynchronous publisher stats: 6,652 msgs/sec ~ 650 KiB/sec ~ min: 36,610.07us ~ avg: 75,131.56us ~ max: 126,173.90us ~ P50: 56,705.94us ~ P90: 111,935.56us ~ P99: 126,173.90us ~ P99.9: 126,173.90us
NATS JetStream durable consumer (fetch) stats: 39,670 msgs/sec ~ 4.8 MiB/sec ~ min: 24.86us ~ avg: 45.35us ~ max: 88.85us ~ P50: 29.72us ~ P90: 67.33us ~ P99: 88.85us ~ P99.9: 88.85us
NATS JetStream asynchronous publisher stats: 4,920 msgs/sec ~ 481 KiB/sec ~ min: 75,931.50us ~ avg: 101,540.49us ~ max: 133,643.07us ~ P50: 82,177.19us ~ P90: 133,643.07us ~ P99: 133,643.07us ~ P99.9: 133,643.07us
 NATS JetStream durable consumer (fetch) aggregated stats: 8,999 msgs/sec ~ 1.1 MiB/sec
             Maximum Messages: unlimited
                     Messages: 0
# tool exit code 0, wall 2.679709362 s
summary (SIGTERM): [2.8 s real, 9.754 s virtual, 122744 events, 12015 verbs] conns=0 in=1953759B out=1919409B 
    ops{SUB=46 HPUB=3 js-api=36 js-stream-create=4 deliver=17022 PUB=17033 js-pub=10000 js-consumer-create=2 js-deliver=7000 js-ack=7000} errors{} cpu=2.58s rss=205MB
```

**kafka**
```
# E-45 kafka: 2026-11-06T21:19:00Z, node v22.22.0, data 63fea66, 4 vCPU, loadavg 4.16 4.43 4.88 5/179 19164
# host: host.ts kafka --listen 127.0.0.1:19290
# tool: sh -c 
Created topic e45.
## producer
10000 records sent, 6958.942241 records/sec (6.80 MB/sec), 294.59 ms avg latency, 616.00 ms max latency, 312 ms 50th, 384 ms 95th, 401 ms 99th, 407 ms 99.9th.
## consumer
2026-11-06 21:19:13:512, 2026-11-06 21:19:14:379, 9.7656, 11.2637, 10000, 11534.0254, 604, 263, 37.1317, 38022.8137
Created topic e45e2e.
## e2e latency
Avg latency: 3.2217 ms
Percentiles: 50th = 2, 99th = 13, 99.9th = 93
# tool exit code 0, wall 23.018709575 s
summary (SIGTERM): [23.1 s real, 5.106 s virtual, 17804 events, 1703 verbs] conns=0 in=11803249B out=11707693B 
    ops{ApiVersions=32 Metadata=15 CreateTopics=2 topic-create=2 InitProducerId=2 Produce=1048 kafka-batch=1668 kafka-record=11000 FindCoordinator=2 JoinGroup=2 join=2 SyncGroup=1 OffsetFetch=1 ListOffsets=2 Fetch=2283 fetch=2283 fetch-bytes=11464748 OffsetCommit=2 offset-commit=17 LeaveGroup=1} errors{} cpu=2.01s rss=185MB
```

**lock**
```
# E-45 lock: 2026-11-06T21:19:24Z, node v22.22.0, loadavg 4.46 4.47 4.89 5/181 21452
## lockloop --clients 1
{"tool":"lockloop (lockbench ported to fero lock())","virtual":true,"clients":1,"conns":1,"locks":0,"seconds":5,"cycles":1698,"cycles_per_s":339.6,"errors":0,"acquire_ms":{"p50":1.478,"p90":1.773,"p99":2.039,"p999":2.147,"max":2.229},"cycle_ms":{"p50":2.949,"p90":3.365,"p99":3.675,"p999":3.899,"max":3.969},"co_corrected":{"expected_interval_ms":2.943,"acquire_ms":{"p50":1.478,"p90":1.773,"p99":2.039,"p999":2.147,"max":2.229},"cycle_ms":{"p50":2.949,"p90":3.365,"p99":3.675,"p999":3.899,"max":3.969}},"sim":{"events":52624,"verbs":4070,"real_s":0.734}}
## lockloop --clients 100
{"tool":"lockloop (lockbench ported to fero lock())","virtual":true,"clients":100,"conns":100,"locks":0,"seconds":5,"cycles":154644,"cycles_per_s":30928.8,"errors":0,"acquire_ms":{"p50":1.627,"p90":2.051,"p99":2.293,"p999":2.447,"max":2.711},"cycle_ms":{"p50":3.341,"p90":3.981,"p99":4.335,"p999":4.567,"max":4.831},"co_corrected":{"expected_interval_ms":3.231,"acquire_ms":{"p50":1.627,"p90":2.051,"p99":2.293,"p999":2.447,"max":2.711},"cycle_ms":{"p50":3.341,"p90":3.981,"p99":4.335,"p999":4.567,"max":4.831}},"sim":{"events":8033559,"verbs":371404,"real_s":791.032}}
```

**nats-1to1-16B-persisted**
```
# E-45 nats-1to1-16B-persisted: 2026-11-06T22:07:29Z, node v22.22.0, data 63fea66, 4 vCPU, loadavg 11.54 6.96 6.45 16/344 20009
# host: host.ts nats --listen 127.0.0.1:14290 --durability persisted
# tool: sh -c /tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad/dl/natscli/unz/nats-0.5.1-linux-amd64/nats -s nats://127.0.0.1:14290 bench sub e45.core --clients 1 --msgs 3000 --size 16B --no-progress & sleep 1; /tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad/dl/natscli/unz/nats-0.5.1-linux-amd64/nats -s nats://127.0.0.1:14290 bench pub e45.core --clients 1 --msgs 3000 --size 16B --no-progress; wait
NATS Core NATS publisher stats: 115,885 msgs/sec ~ 1.8 MiB/sec ~ min: 0.07us ~ avg: 0.16us ~ max: 53.14us ~ P50: 0.07us ~ P90: 0.10us ~ P99: 0.15us ~ P99.9: 31.79us
NATS Core NATS subscriber stats: 6,772 msgs/sec ~ 106 KiB/sec
# tool exit code 0, wall 1.511560443 s
summary (SIGTERM): [1.5 s real, 3.073 s virtual, 39213 events, 3000 verbs] conns=0 in=105419B out=111436B 
    ops{SUB=1 PUB=3000 deliver=3000} errors{} cpu=0.79s rss=143MB
```

**nats-1to1-16B**
```
# E-45 nats-1to1-16B: 2026-11-06T22:07:20Z, node v22.22.0, data 63fea66, 4 vCPU, loadavg 8.91 6.31 6.24 24/296 19497
# host: host.ts nats --listen 127.0.0.1:14290
# tool: sh -c /tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad/dl/natscli/unz/nats-0.5.1-linux-amd64/nats -s nats://127.0.0.1:14290 bench sub e45.core --clients 1 --msgs 10000 --size 16B --no-progress & sleep 1; /tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad/dl/natscli/unz/nats-0.5.1-linux-amd64/nats -s nats://127.0.0.1:14290 bench pub e45.core --clients 1 --msgs 10000 --size 16B --no-progress; wait
NATS Core NATS publisher stats: 112,067 msgs/sec ~ 1.7 MiB/sec ~ min: 0.07us ~ avg: 0.20us ~ max: 950.34us ~ P50: 0.08us ~ P90: 0.09us ~ P99: 0.13us ~ P99.9: 5.86us
NATS Core NATS subscriber stats: 3,106 msgs/sec ~ 49 KiB/sec
# tool exit code 0, wall 4.339693113 s
summary (SIGTERM): [4.5 s real, 5.405 s virtual, 134932 events, 10000 verbs] conns=0 in=350419B out=370436B 
    ops{SUB=1 PUB=10000 deliver=10000} errors{} cpu=2.84s rss=189MB
```

**nats-1to16-1KB**
```
# E-45 nats-1to16-1KB: 2026-11-06T22:07:26Z, node v22.22.0, data 63fea66, 4 vCPU, loadavg 11.54 6.96 6.45 18/292 19751
# host: host.ts nats --listen 127.0.0.1:14290
# tool: sh -c /tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad/dl/natscli/unz/nats-0.5.1-linux-amd64/nats -s nats://127.0.0.1:14290 bench sub e45.core --clients 16 --msgs 2000 --size 1KB --no-progress & sleep 1; /tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad/dl/natscli/unz/nats-0.5.1-linux-amd64/nats -s nats://127.0.0.1:14290 bench pub e45.core --clients 1 --msgs 2000 --size 1KB --no-progress; wait
NATS Core NATS publisher stats: 21,447 msgs/sec ~ 21 MiB/sec ~ min: 0.09us ~ avg: 0.44us ~ max: 43.32us ~ P50: 0.11us ~ P90: 0.13us ~ P99: 6.71us ~ P99.9: 29.31us
 NATS Core NATS subscriber aggregated stats: 26,082 msgs/sec ~ 25 MiB/sec
# tool exit code 0, wall 2.338490817 s
summary (SIGTERM): [2.5 s real, 1.091 s virtual, 27092 events, 2000 verbs] conns=0 in=2093689B out=33507714B 
    ops{SUB=16 PUB=2000 deliver=32000} errors{} cpu=1.25s rss=159MB
```

**nats-latency-16B**
```
# E-45 nats-latency-16B: 2026-11-06T22:07:31Z, node v22.22.0, data 63fea66, 4 vCPU, loadavg 12.06 7.15 6.51 18/352 20150
# host: host.ts nats --listen 127.0.0.1:14290
# tool: /tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad/dl/natscli/unz/nats-0.5.1-linux-amd64/nats -s nats://127.0.0.1:14290 latency --server-b nats://127.0.0.1:14290 --size 16 --rate 1000 --duration 5s
22:07:37 HDR Percentiles:
22:07:37 Actual Msgs/Sec: 998
22:07:37 Median Latency : 471µs
22:07:37 Maximum Latency: 71.45ms
# tool exit code 0, wall 5.082052856 s
summary (SIGTERM): [5.2 s real, 3.882 s virtual, 62111 events, 5000 verbs] conns=0 in=325455B out=335442B 
    ops{SUB=1 PUB=5000 deliver=5000} errors{} cpu=2.04s rss=152MB
```

**nats-service**
```
# E-45 nats-service: 2026-11-06T22:07:37Z, node v22.22.0, data 63fea66, 4 vCPU, loadavg 12.30 7.28 6.56 18/319 20291
# host: host.ts nats --listen 127.0.0.1:14290
# tool: sh -c /tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad/dl/natscli/unz/nats-0.5.1-linux-amd64/nats -s nats://127.0.0.1:14290 bench service serve e45.svc --clients 2 --msgs 1000 --no-progress & srv=$!; sleep 1; /tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad/dl/natscli/unz/nats-0.5.1-linux-amd64/nats -s nats://127.0.0.1:14290 bench service request e45.svc --clients 1 --msgs 1000 --size 16B --no-progress; kill -TERM $srv; wait
NATS Core NATS service requester stats: 1,045 msgs/sec ~ 16 KiB/sec ~ min: 239.47us ~ avg: 953.49us ~ max: 46,415.86us ~ P50: 637.62us ~ P90: 1,374.54us ~ P99: 6,248.37us ~ P99.9: 46,415.86us
# tool exit code 0, wall 2.033819516 s
summary (SIGTERM): [2.2 s real, 0.971 s virtual, 21125 events, 2000 verbs] conns=0 in=124375B out=127654B 
    ops{SUB=21 PUB=2000 deliver=2000} errors{} cpu=1.19s rss=136MB
```

**order**
```
# E-45 order: 2026-11-06T22:07:07Z, node v22.22.0, loadavg 6.70 5.81 6.08 10/194 19148
pipelined (40 writes in flight): 12 of 100 seeds commit out of issue order (225 inversions); 4000 entries committed for 4000 writes; 0 writes missing
chained (each write after the previous answer): 0 of 100 seeds commit out of issue order (0 inversions); 4000 entries committed for 4000 writes; 0 writes missing
```

**resp-p1-fresh**
```
# E-45 resp-p1-fresh: 2026-11-06T21:13:27Z, node v22.22.0, data 63fea66, 4 vCPU, loadavg 5.77 4.26 4.95 7/269 17618
# host: host.ts resp --listen 127.0.0.1:16390 --get fresh
# tool: redis-benchmark -p 16390 -c 200 --threads 4 -r 100000 -d 100 --precision 3 -n 5000 -P 1 -t get
====== GET ======
  throughput summary: 9900.99 requests per second
       16.701     4.664    14.271    38.143    53.375    59.263
# tool exit code 0, wall .678339566 s
summary (SIGTERM): [0.8 s real, 0.036 s virtual, 20054 events, 5000 verbs] conns=0 in=180077B out=25050B 
    ops{CONFIG=2 GET=5000} errors{} cpu=0.88s rss=140MB
```

**resp-p1**
```
# E-45 resp-p1: 2026-11-06T21:13:12Z, node v22.22.0, data 63fea66, 4 vCPU, loadavg 3.79 3.81 4.82 20/276 17283
# host: host.ts resp --listen 127.0.0.1:16390
# tool: redis-benchmark -p 16390 -c 200 --threads 4 -r 100000 -d 100 --precision 3 -n 10000 -P 1 -t set,get,incr
====== SET ======
  throughput summary: 3490.40 requests per second
       50.151     2.520    29.839   146.431   301.055   393.727
====== GET ======
  throughput summary: 18726.59 requests per second
        8.327     0.200     5.127    26.239    44.767    55.615
====== INCR ======
  throughput summary: 6523.16 requests per second
       24.917     5.312    21.759    59.935    95.423   120.255
# tool exit code 0, wall 5.418131331 s
summary (SIGTERM): [5.5 s real, 0.144 s virtual, 68083 events, 30000 verbs] conns=0 in=2210077B out=241608B 
    ops{CONFIG=2 SET=10000 GET=10000 INCR=10000} errors{} cpu=3.52s rss=356MB
```

**resp-p16**
```
# E-45 resp-p16: 2026-11-06T21:13:18Z, node v22.22.0, data 63fea66, 4 vCPU, loadavg 5.49 4.18 4.93 10/219 17414
# host: host.ts resp --listen 127.0.0.1:16390
# tool: redis-benchmark -p 16390 -c 200 --threads 4 -r 100000 -d 100 --precision 3 -n 20000 -P 16 -t set,get,incr
====== SET ======
  throughput summary: 5602.24 requests per second
      438.387    75.776   384.255   800.255  1008.127  1053.695
====== GET ======
  throughput summary: 19801.98 requests per second
       94.664     2.728    95.359   151.551   182.911   330.495
====== INCR ======
  throughput summary: 5605.38 requests per second
      436.621    77.184   352.767  1086.463  1093.631  1095.679
# tool exit code 0, wall 8.643961085 s
summary (SIGTERM): [8.8 s real, 0.028 s virtual, 121164 events, 60000 verbs] conns=7 in=4420077B out=653425B 
    ops{CONFIG=2 SET=20000 GET=20000 INCR=20000} errors{} cpu=5.75s rss=595MB
```

**typecheck**
```
# tsc Version 6.0.2, 2026-11-06T21:13:04Z
ok: tsc --strict, exit 0
```
