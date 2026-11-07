# ablation: real Elle 0.2.8 with the Go port's rule for never-read appends (E22B_RULE=port), 2026-11-06T22:08:25Z, openjdk version "21.0.12.1" 2026-08-18, 4 vCPU, load 13.45 8.39 6.98
# Real Elle 0.2.8 vs the Go port (tipocket v1.0.0): 1200 histories read, 0 errors, 0 with no port result

| variant | mode | histories | read committed valid: port / real | agree | serializable valid: port / real | agree | G0 histories: port / real | G-single histories: port / real | same anomaly types | real Elle's anomalies (histories with it: total cases) |
|---|---|---|---|---|---|---|---|---|---|---|
| saga | calm | 100 | 84 / 84 | 100 | 29 / 29 | 100 | 16 / 16 | 71 / 71 | 98 | G-single-item 71: 96, G0 16: 16 |
| saga | faults | 100 | 81 / 81 | 100 | 39 / 39 | 100 | 19 / 19 | 61 / 61 | 95 | G-single-item 61: 87, G0 19: 19 |
| saga | shuffle | 100 | 90 / 90 | 100 | 20 / 20 | 100 | 10 / 10 | 80 / 80 | 90 | G-single-item 80: 128, G0 10: 10 |
| owned | calm | 100 | 100 / 100 | 100 | 28 / 28 | 100 | 0 / 0 | 72 / 72 | 95 | G-single-item 72: 96 |
| owned | faults | 100 | 100 / 100 | 100 | 34 / 34 | 100 | 0 / 0 | 66 / 66 | 96 | G-single-item 66: 93 |
| owned | shuffle | 100 | 100 / 100 | 100 | 23 / 23 | 100 | 0 / 0 | 77 / 77 | 94 | G-single-item 77: 121 |
| undo | calm | 100 | 12 / 12 | 100 | 3 / 3 | 100 | 1 / 1 | 63 / 75 | 38 | G-nonadjacent-item 12: 12, G-single-item 75: 77, G0 1: 1, G1a 46: 451, incompatible-order 87: 151 |
| undo | faults | 100 | 19 / 19 | 100 | 8 / 8 | 100 | 2 / 2 | 60 / 69 | 47 | G-nonadjacent-item 12: 12, G-single-item 69: 71, G0 2: 2, G1a 39: 304, incompatible-order 79: 131 |
| undo | shuffle | 100 | 8 / 8 | 100 | 4 / 4 | 100 | 2 / 2 | 61 / 66 | 52 | G-nonadjacent-item 9: 9, G-single-item 66: 73, G0 2: 2, G1a 72: 598, incompatible-order 86: 161 |
| nolock | calm | 100 | 0 / 0 | 100 | 0 / 0 | 100 | 95 / 95 | 100 / 100 | 7 | G-single-item 100: 201, G0 95: 138, duplicate-elements 100: 571 |
| nolock | faults | 100 | 0 / 0 | 100 | 0 / 0 | 100 | 95 / 95 | 100 / 100 | 7 | G-single-item 100: 186, G0 95: 134, duplicate-elements 100: 564 |
| nolock | shuffle | 100 | 0 / 0 | 100 | 0 / 0 | 100 | 92 / 94 | 100 / 100 | 7 | G-nonadjacent-item 1: 1, G-single-item 100: 187, G0 94: 138, duplicate-elements 100: 557 |

Total: 1200 histories; read committed verdict agrees on 1200, serializable on 1200, anomaly type set (item names mapped) on 726.
Same verdicts, different types: order in nolock: 2, order in undo: 27, policy in nolock: 277, policy in owned: 15, policy in saga: 17, policy in undo: 136 (policy: real Elle skips a cycle type implied by a worse one it found; order: the two built different version orders, from never-read appends, duplicates or reads that disagree)
Real Elle time per history (both checks): median 23.0 ms, max 397 ms, total 37.6 s.

## Histories where a verdict differs (0)

## Same verdicts, different anomaly types (474 histories), by pattern

| histories | the port's types | real Elle's types (item names mapped) |
|---|---|---|
| 263 | G-nonadjacent, G-single, G0, duplicate-elements | G-single, G0, duplicate-elements |
| 78 | G-nonadjacent, G-single, G1a, incompatible-order | G-single, G1a, incompatible-order |
| 43 | G-nonadjacent, G-single, incompatible-order | G-single, incompatible-order |
| 40 | G-nonadjacent, G-single | G-single |
| 14 | G-nonadjacent, G1a, incompatible-order | G-single, G1a, incompatible-order |
| 14 | G-nonadjacent, G-single, duplicate-elements | G-single, duplicate-elements |
| 7 | G-nonadjacent, G-single, G0 | G-single, G0 |
| 5 | G-nonadjacent, incompatible-order | G-single, incompatible-order |
| 4 | incompatible-order | G-single, incompatible-order |
| 2 | G-nonadjacent | G-single |
| 2 | G-nonadjacent, G-single, duplicate-elements | G-single, G0, duplicate-elements |
| 1 | G1a, incompatible-order | G-single, G1a, incompatible-order |
| 1 | G-nonadjacent, G1a, incompatible-order | G1a, incompatible-order |
