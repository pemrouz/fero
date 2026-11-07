# Knossos (competition) on every partition of 120 ops or fewer in every other history file, time limit 60000 ms, 2026-11-06T22:35:26Z, openjdk version "21.0.12.1" 2026-08-18, 4 vCPU, load 16.24 14.66 12.79
# jobs: 180759 partitions; checked: 83500
# Knossos 0.3.16 vs Porcupine v1.3.1, per partition (83500 partitions checked, 0 with no Porcupine line)

| history file | partitions | ops (max per partition) | both linearizable | both not | Porcupine only not | Knossos only not | Knossos unknown | Knossos ms: median / max / total | Porcupine ms total |
|---|---|---|---|---|---|---|---|---|---|
| core-determinism-calm.jsonl | 600 | 4400 (10) | 600 | 0 | 0 | 0 | 0 | 11 / 290 / 8.5 s | 44 |
| core-determinism-faults.jsonl | 600 | 4400 (10) | 600 | 0 | 0 | 0 | 0 | 8 / 56 / 5.4 s | 47 |
| core-determinism-shuffle.jsonl | 600 | 4400 (10) | 600 | 0 | 0 | 0 | 0 | 7 / 47 / 4.7 s | 57 |
| core-exactly-once-calm.jsonl | 400 | 6000 (17) | 400 | 0 | 0 | 0 | 0 | 40 / 260 / 17.8 s | 43 |
| core-exactly-once-faults.jsonl | 400 | 6000 (17) | 400 | 0 | 0 | 0 | 0 | 40 / 164 / 17.1 s | 46 |
| core-exactly-once-shuffle.jsonl | 400 | 6000 (17) | 400 | 0 | 0 | 0 | 0 | 43 / 272 / 19.3 s | 56 |
| core-features-calm.jsonl | 5800 | 11800 (11) | 5800 | 0 | 0 | 0 | 0 | 4 / 84 / 25.5 s | 228 |
| core-features-faults.jsonl | 5800 | 11800 (11) | 5800 | 0 | 0 | 0 | 0 | 4 / 118 / 22.4 s | 237 |
| core-features-shuffle.jsonl | 5800 | 11800 (11) | 5800 | 0 | 0 | 0 | 0 | 4 / 198 / 25.7 s | 266 |
| cts-calm.jsonl | 600 | 1898 (5) | 600 | 0 | 0 | 0 | 0 | 4 / 20 / 3.0 s | 36 |
| cts-faults.jsonl | 600 | 1899 (5) | 600 | 0 | 0 | 0 | 0 | 4 / 43 / 3.0 s | 32 |
| cts-shuffle.jsonl | 600 | 1899 (5) | 600 | 0 | 0 | 0 | 0 | 4 / 40 / 3.0 s | 36 |
| order-fixed-calm.jsonl | 100 | 4000 (40) | 100 | 0 | 0 | 0 | 0 | 54 / 143 / 5.6 s | 75 |
| order-fixed-faults.jsonl | 100 | 4000 (40) | 100 | 0 | 0 | 0 | 0 | 43 / 92 / 4.5 s | 91 |
| order-fixed-shuffle.jsonl | 100 | 4000 (40) | 100 | 0 | 0 | 0 | 0 | 50 / 101 / 5.2 s | 176 |
| order-planted-calm.jsonl | 2100 | 4000 (20) | 2100 | 0 | 0 | 0 | 0 | 4 / 96 / 11.7 s | 100 |
| order-planted-faults.jsonl | 2100 | 4000 (20) | 2100 | 0 | 0 | 0 | 0 | 4 / 76 / 10.6 s | 81 |
| order-planted-shuffle.jsonl | 2100 | 4000 (20) | 2100 | 0 | 0 | 0 | 0 | 4 / 52 / 11.3 s | 63 |
| p01-calm.jsonl | 200 | 500 (4) | 200 | 0 | 0 | 0 | 0 | 4 / 53 / 1.0 s | 11 |
| p01-faults.jsonl | 200 | 500 (4) | 200 | 0 | 0 | 0 | 0 | 4 / 89 / 1.1 s | 16 |
| p01-shuffle.jsonl | 200 | 500 (4) | 200 | 0 | 0 | 0 | 0 | 5 / 16 / 1.1 s | 11 |
| p02-calm.jsonl | 4300 | 8000 (4) | 4300 | 0 | 0 | 0 | 0 | 4 / 104 / 20.2 s | 451 |
| p02-faults.jsonl | 4300 | 7971 (4) | 4300 | 0 | 0 | 0 | 0 | 4 / 39 / 16.3 s | 592 |
| p02-shuffle.jsonl | 4300 | 7971 (4) | 4300 | 0 | 0 | 0 | 0 | 4 / 57 / 15.6 s | 468 |
| p03-calm.jsonl | 6000 | 8400 (13) | 6000 | 0 | 0 | 0 | 0 | 4 / 56 / 23.1 s | 852 |
| p03-faults.jsonl | 6000 | 8400 (13) | 6000 | 0 | 0 | 0 | 0 | 2 / 250 / 21.0 s | 515 |
| p03-shuffle.jsonl | 6000 | 8400 (13) | 6000 | 0 | 0 | 0 | 0 | 2 / 167 / 23.2 s | 215 |
| p04-calm.jsonl | 100 | 250 (3) | 100 | 0 | 0 | 0 | 0 | 2 / 67 / 0.6 s | 5 |
| p04-faults.jsonl | 100 | 250 (3) | 100 | 0 | 0 | 0 | 0 | 2 / 154 / 0.8 s | 5 |
| p04-shuffle.jsonl | 100 | 250 (3) | 100 | 0 | 0 | 0 | 0 | 1 / 142 / 0.5 s | 4 |
| p05-calm.jsonl | 300 | 2400 (8) | 300 | 0 | 0 | 0 | 0 | 228 / 1007 / 77.3 s | 39 |
| p05-faults.jsonl | 300 | 2400 (8) | 300 | 0 | 0 | 0 | 0 | 284 / 970 / 90.0 s | 243 |
| p05-shuffle.jsonl | 300 | 2400 (8) | 300 | 0 | 0 | 0 | 0 | 206 / 692 / 62.8 s | 303 |
| p08-calm.jsonl | 17000 | 116667 (36) | 17000 | 0 | 0 | 0 | 0 | 4 / 1121 / 608.7 s | 2147 |
| p08-faults.jsonl | 5000 | 35604 (36) | 5000 | 0 | 0 | 0 | 0 | 3 / 1510 / 215.4 s | 996 |
| **total** | 83500 | 307159 | 83500 | 0 | 0 | 0 | 0 | total 1382.7 s | 8588 |

## Disagreements and unknowns (0)
