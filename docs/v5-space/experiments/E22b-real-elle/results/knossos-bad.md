# Knossos (competition) on the known-bad histories, time limit 60000 ms, 2026-11-06T22:09:27Z, openjdk version "21.0.12.1" 2026-08-18, 4 vCPU, load 15.24 9.79 7.54
# Knossos 0.3.16 vs Porcupine v1.3.1, per partition (2800 partitions checked, 0 with no Porcupine line)

| history file | partitions | ops (max per partition) | both linearizable | both not | Porcupine only not | Knossos only not | Knossos unknown | Knossos ms: median / max / total | Porcupine ms total |
|---|---|---|---|---|---|---|---|---|---|
| lin-kv-calm-before.jsonl | 600 | 25151 (68) | 599 | 1 | 0 | 0 | 0 | 65 / 716 / 46.4 s | 440 |
| mut-lostcommit-lin-kv.jsonl | 36 | 1513 (59) | 30 | 6 | 0 | 0 | 0 | 60 / 202 / 2.3 s | 8 |
| mut-lostcommit-p11.jsonl | 84 | 487 (12) | 74 | 10 | 0 | 0 | 0 | 4 / 51 / 0.5 s | 5 |
| mut-lostcommit-p14.jsonl | 400 | 944 (4) | 394 | 6 | 0 | 0 | 0 | 2 / 61 / 1.3 s | 19 |
| mut-nodedup-core-exactly-once.jsonl | 400 | 6000 (17) | 367 | 33 | 0 | 0 | 0 | 40 / 232 / 17.3 s | 55 |
| mut-nodedup-lin-kv.jsonl | 600 | 25295 (68) | 582 | 18 | 0 | 0 | 0 | 64 / 277 / 41.8 s | 328 |
| mut-nodedup-p11.jsonl | 280 | 1560 (12) | 260 | 20 | 0 | 0 | 0 | 4 / 48 / 1.8 s | 23 |
| mut-nodedup-p14.jsonl | 400 | 1100 (4) | 400 | 0 | 0 | 0 | 0 | 3 / 91 / 2.0 s | 33 |
| **total** | 2800 | 62050 | 2706 | 94 | 0 | 0 | 0 | total 113.2 s | 913 |

## Disagreements and unknowns (0)
