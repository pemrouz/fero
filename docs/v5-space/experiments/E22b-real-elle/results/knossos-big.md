# Knossos (competition) on the partitions of more than 120 ops (KBIG=0 per file, 0 = all), seeded random order, 120000 ms each, the hold cut at 25 min, 2026-11-07T00:14:40Z, openjdk version "21.0.12.1" 2026-08-18, 4 vCPU, load 1.01 0.49 0.19
sample p09-calm.jsonl: 200 partitions, 100 with 121 to 1000000 ops, took 100
sample p09-faults.jsonl: 200 partitions, 100 with 121 to 1000000 ops, took 100
sample p09-shuffle.jsonl: 200 partitions, 100 with 121 to 1000000 ops, took 100
sample p22-calm.jsonl: 300 partitions, 100 with 121 to 1000000 ops, took 100
sample p22-faults.jsonl: 300 partitions, 100 with 121 to 1000000 ops, took 100
sample p22-shuffle.jsonl: 300 partitions, 100 with 121 to 1000000 ops, took 100
# Knossos 0.3.16 vs Porcupine v1.3.1, per partition (600 partitions checked, 0 with no Porcupine line)

| history file | partitions | ops (max per partition) | both linearizable | both not | Porcupine only not | Knossos only not | Knossos unknown | Knossos ms: median / max / total | Porcupine ms total |
|---|---|---|---|---|---|---|---|---|---|
| p09-calm.jsonl | 100 | 68295 (683) | 100 | 0 | 0 | 0 | 0 | 177 / 689 / 20.7 s | 521 |
| p09-faults.jsonl | 100 | 67965 (681) | 100 | 0 | 0 | 0 | 0 | 177 / 848 / 21.3 s | 349 |
| p09-shuffle.jsonl | 100 | 68160 (685) | 100 | 0 | 0 | 0 | 0 | 191 / 495 / 20.7 s | 400 |
| p22-calm.jsonl | 100 | 89986 (902) | 100 | 0 | 0 | 0 | 0 | 38 / 952 / 6.1 s | 298 |
| p22-faults.jsonl | 100 | 89764 (902) | 100 | 0 | 0 | 0 | 0 | 36 / 246 / 4.9 s | 199 |
| p22-shuffle.jsonl | 100 | 89737 (902) | 100 | 0 | 0 | 0 | 0 | 44 / 773 / 6.3 s | 303 |
| **total** | 600 | 473907 | 600 | 0 | 0 | 0 | 0 | total 80.1 s | 2070 |

## Disagreements and unknowns (0)
