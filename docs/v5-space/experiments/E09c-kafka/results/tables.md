# Tables (median of runs, range in brackets)

## Producer (kafka-producer-perf-test, 1 KiB, acks=all; steady state after the warm-up records)

| system:setup:test | runs | records/s | MB/s | p50 ms | p95 ms | p99 ms | p99.9 ms | max ms | e2e p50 ms | e2e p99 ms | e2e p99.9 ms | e2e max ms | server cores | client cores | other cores | broker µs CPU/record | load before (1-min) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| kafka:default:max-default | 3 | 65,807 (65,462-66,946) | 64.3 (63.9-65.4) | 425 (408-425) | 726 (718-733) | 931 (825-1,033) | 985 (856-1,151) | 1,028 (870-1,169) | - | - | - | - | 2.74 (2.71-2.77) | 0.81 (0.80-0.81) | 0.05 (0.05-0.05) | 41.2 (40.9-42.3) | 4.76 / 4.28 / 4.71 |
| kafka:default:max-omb | 3 | 240,043 (238,014-257,107) | 234.4 (232.4-251.1) | 98 (95-99) | 290 (237-302) | 396 (312-616) | 521 (439-742) | 570 (535-760) | - | - | - | - | 1.74 (1.72-1.78) | 1.35 (1.34-1.38) | 0.08 (0.08-0.11) | 7.3 (6.7-7.4) | 4.79 / 4.89 / 5.60 |
| kafka:default:half | 3 | 125,135 (124,883-130,344) | 122.2 (122.0-127.3) | 58 (56-81) | 319 (307-354) | 631 (493-649) | 853 (753-1,021) | 882 (781-1,127) | 63 (60-86) | 638 (498-694) | 862 (754-1,125) | 884 (788-1,193) | 2.28 (2.24-2.29) | 1.38 (1.38-1.42) | -0.02 (-0.03--0.01) | 18.3 (17.2-18.3) | 4.96 / 2.81 / 3.94 |
| kafka:default:rate50k | 3 | 49,960 (49,940-49,960) | 48.8 (48.8-48.8) | 2 (2-2) | 5 (5-7) | 15 (13-82) | 348 (341-390) | 411 (373-499) | 2 (2-2) | 15 (14-84) | 350 (343-391) | 412 (374-499) | 1.18 (1.17-1.19) | 0.79 (0.79-0.79) | -0.01 (-0.02--0.00) | 23.6 (23.4-23.8) | 6.15 / 5.15 / 4.84 |

## Consumers (kafka-consumer-perf-test; kafka-share-consumer-perf-test with 4 consumers in one share group)

| system:setup:test | runs | records | MB/s (whole run) | records/s (whole run) | fetch MB/s | fetch records/s | server cores | client cores | load before (1-min) |
|---|---|---|---|---|---|---|---|---|---|
| kafka:default:consume | 3 | 900,000 (900,000-900,000) | 307.3 (302.3-344.5) | 314,685 (309,598-352,803) | 509.8 (466.0-541.9) | 522,042 (477,200-554,871) | 0.68 (0.63-0.75) | 1.36 (1.32-1.39) | 5.43 / 5.98 / 6.40 |
| kafka:default:share-4c | 3 | 900,000 (900,000-900,000) | 76.7 (70.7-78.3) | 78,534 (72,400-80,200) | - | - | 1.43 (1.34-1.51) | 0.62 (0.58-0.66) | 5.08 / 5.37 / 6.37 |

## One record at a time (kafka-e2e-latency, 1 KiB, acks=all): send, wait for the ack, wait for the consumer

| system:setup:test | runs | records | avg ms | p50 ms | p99 ms | p99.9 ms | server cores | client cores | load before (1-min) |
|---|---|---|---|---|---|---|---|---|---|
| kafka:default:e2e1 | 3 | 12000 | 1.193 (1.189-1.218) | 1.000 (1.000-1.000) | 4.000 (4.000-4.000) | 8.000 (8.000-9.000) | 1.18 (1.15-1.20) | 0.93 (0.92-0.96) | 4.34 / 3.91 / 3.58 |

## One record in flight, ack timed in µs (AckProbe on Kafka's Java client: acks=all, linger.ms=0)

| system:setup:test | runs | records | acks/s | p50 ms | p90 ms | p99 ms | p99.9 ms | max ms | server cores | client cores | load before (1-min) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| kafka:default:ack1 | 3 | 20,000 (20,000-20,000) | 1,491 (1,433-1,509) | 0.606 (0.605-0.629) | 0.871 (0.858-0.919) | 1.636 (1.399-1.657) | 5.008 (4.717-5.973) | 16.6 (15.7-19.8) | 1.25 (1.24-1.25) | 0.56 (0.56-0.58) | 3.32 / 3.58 / 2.80 |
