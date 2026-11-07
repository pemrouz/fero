# pilot: Knossos (competition) on every lin-kv partition, time limit 60000 ms, 2026-11-06T21:38:47Z, openjdk version "21.0.12.1" 2026-08-18, 4 vCPU, load 12.88 7.27 5.61
# Knossos 0.3.16 vs Porcupine v1.3.1, per partition (1800 partitions checked, 0 with no Porcupine line)

| history file | partitions | ops (max per partition) | both linearizable | both not | Porcupine only not | Knossos only not | Knossos unknown | Knossos ms: median / max / total | Porcupine ms total |
|---|---|---|---|---|---|---|---|---|---|
| lin-kv-calm.jsonl | 600 | 25140 (68) | 600 | 0 | 0 | 0 | 0 | 72 / 741 / 49.6 s | 190 |
| lin-kv-faults.jsonl | 600 | 25240 (68) | 600 | 0 | 0 | 0 | 0 | 63 / 268 / 40.5 s | 281 |
| lin-kv-shuffle.jsonl | 600 | 25295 (68) | 600 | 0 | 0 | 0 | 0 | 56 / 176 / 37.8 s | 199 |
| **total** | 1800 | 75675 | 1800 | 0 | 0 | 0 | 0 | total 127.9 s | 671 |

## Disagreements and unknowns (0)
