# real Elle 0.2.8 list-append on E-22's 1,200 EDN histories, 2026-11-06T22:07:30Z, openjdk version "21.0.12.1" 2026-08-18, 4 vCPU, load 11.54 6.96 6.45
# Real Elle 0.2.8 vs the Go port (tipocket v1.0.0): 1200 histories read, 0 errors, 0 with no port result

| variant | mode | histories | read committed valid: port / real | agree | serializable valid: port / real | agree | G0 histories: port / real | G-single histories: port / real | same anomaly types | real Elle's anomalies (histories with it: total cases) |
|---|---|---|---|---|---|---|---|---|---|---|
| saga | calm | 100 | 84 / 84 | 100 | 29 / 29 | 100 | 16 / 16 | 71 / 71 | 98 | G-single-item 71: 96, G0 16: 16 |
| saga | faults | 100 | 81 / 81 | 100 | 39 / 39 | 100 | 19 / 19 | 61 / 61 | 95 | G-single-item 61: 87, G0 19: 19 |
| saga | shuffle | 100 | 90 / 90 | 100 | 20 / 20 | 100 | 10 / 10 | 80 / 80 | 90 | G-single-item 80: 128, G0 10: 10 |
| owned | calm | 100 | 100 / 100 | 100 | 28 / 28 | 100 | 0 / 0 | 72 / 72 | 95 | G-single-item 72: 96 |
| owned | faults | 100 | 100 / 100 | 100 | 34 / 34 | 100 | 0 / 0 | 66 / 66 | 96 | G-single-item 66: 93 |
| owned | shuffle | 100 | 100 / 100 | 100 | 23 / 23 | 100 | 0 / 0 | 77 / 77 | 94 | G-single-item 77: 121 |
| undo | calm | 100 | 12 / 4 | 92 | 3 / 0 | 97 | 1 / 59 | 63 / 100 | 3 | G-single-item 100: 104, G0 59: 59, G1a 46: 451, incompatible-order 87: 151 |
| undo | faults | 100 | 19 / 5 | 86 | 8 / 0 | 92 | 2 / 65 | 60 / 100 | 4 | G-single-item 100: 102, G0 65: 65, G1a 39: 304, incompatible-order 79: 131 |
| undo | shuffle | 100 | 8 / 3 | 95 | 4 / 0 | 96 | 2 / 59 | 61 / 98 | 11 | G-single-item 98: 108, G0 59: 59, G1a 72: 598, incompatible-order 86: 161 |
| nolock | calm | 100 | 0 / 0 | 100 | 0 / 0 | 100 | 95 / 95 | 100 / 100 | 7 | G-single-item 100: 201, G0 95: 138, duplicate-elements 100: 571 |
| nolock | faults | 100 | 0 / 0 | 100 | 0 / 0 | 100 | 95 / 95 | 100 / 100 | 7 | G-single-item 100: 186, G0 95: 134, duplicate-elements 100: 564 |
| nolock | shuffle | 100 | 0 / 0 | 100 | 0 / 0 | 100 | 92 / 94 | 100 / 100 | 7 | G-nonadjacent-item 1: 1, G-single-item 100: 187, G0 94: 138, duplicate-elements 100: 557 |

Total: 1200 histories; read committed verdict agrees on 1173, serializable on 1185, anomaly type set (item names mapped) on 607.
Same verdicts, different types: order in nolock: 2, order in undo: 177, policy in nolock: 277, policy in owned: 15, policy in saga: 17, policy in undo: 72 (policy: real Elle skips a cycle type implied by a worse one it found; order: the two built different version orders, from never-read appends, duplicates or reads that disagree)
Real Elle time per history (both checks): median 24.0 ms, max 378 ms, total 39.8 s.

## Histories where a verdict differs (33)
- undo-calm-seed100.edn: read committed: port True, real False ['G0']; serializable: port False, real False; port {'G-nonadjacent': 1, 'G-single': 1}, real {'G-single-item': 1, 'G0': 1}
- undo-calm-seed14.edn: read committed: port True, real False ['G0']; serializable: port True, real False; port {}, real {'G-single-item': 1, 'G0': 1}
- undo-calm-seed4.edn: read committed: port True, real True []; serializable: port True, real False; port {}, real {'G-single-item': 1}
- undo-calm-seed42.edn: read committed: port True, real False ['G0']; serializable: port False, real False; port {'G-nonadjacent': 1, 'G-single': 1}, real {'G-single-item': 1, 'G0': 1}
- undo-calm-seed44.edn: read committed: port True, real False ['G0']; serializable: port True, real False; port {}, real {'G-single-item': 1, 'G0': 1}
- undo-calm-seed50.edn: read committed: port True, real False ['G0']; serializable: port False, real False; port {'G-single': 1}, real {'G-single-item': 1, 'G0': 1}
- undo-calm-seed7.edn: read committed: port True, real False ['G0']; serializable: port False, real False; port {'G-nonadjacent': 1, 'G-single': 1}, real {'G-single-item': 1, 'G0': 1}
- undo-calm-seed74.edn: read committed: port True, real False ['G0']; serializable: port False, real False; port {'G-nonadjacent': 1, 'G-single': 1}, real {'G-single-item': 1, 'G0': 1}
- undo-calm-seed90.edn: read committed: port True, real False ['G0']; serializable: port False, real False; port {'G-nonadjacent': 1, 'G-single': 1}, real {'G-single-item': 1, 'G0': 1}
- undo-faults-seed11.edn: read committed: port True, real False ['G0']; serializable: port True, real False; port {}, real {'G-single-item': 1, 'G0': 1}
- undo-faults-seed14.edn: read committed: port True, real False ['G0']; serializable: port False, real False; port {'G-nonadjacent': 1}, real {'G-single-item': 1, 'G0': 1}
- undo-faults-seed23.edn: read committed: port True, real False ['G0']; serializable: port False, real False; port {'G-nonadjacent': 1, 'G-single': 1}, real {'G-single-item': 1, 'G0': 1}
- undo-faults-seed26.edn: read committed: port True, real False ['G0']; serializable: port False, real False; port {'G-single': 1}, real {'G-single-item': 1, 'G0': 1}
- undo-faults-seed4.edn: read committed: port True, real True []; serializable: port True, real False; port {}, real {'G-single-item': 1}
- undo-faults-seed42.edn: read committed: port True, real False ['G0']; serializable: port False, real False; port {'G-nonadjacent': 1, 'G-single': 1}, real {'G-single-item': 1, 'G0': 1}
- undo-faults-seed44.edn: read committed: port True, real True []; serializable: port True, real False; port {}, real {'G-single-item': 1}
- undo-faults-seed5.edn: read committed: port True, real False ['G0']; serializable: port True, real False; port {}, real {'G-single-item': 1, 'G0': 1}
- undo-faults-seed50.edn: read committed: port True, real False ['G0']; serializable: port False, real False; port {'G-single': 1}, real {'G-single-item': 1, 'G0': 1}
- undo-faults-seed57.edn: read committed: port True, real False ['G0']; serializable: port False, real False; port {'G-single': 1}, real {'G-single-item': 1, 'G0': 1}
- undo-faults-seed7.edn: read committed: port True, real False ['G0']; serializable: port False, real False; port {'G-nonadjacent': 1, 'G-single': 1}, real {'G-single-item': 1, 'G0': 1}
- undo-faults-seed78.edn: read committed: port True, real False ['G0']; serializable: port True, real False; port {}, real {'G-single-item': 1, 'G0': 1}
- undo-faults-seed82.edn: read committed: port True, real False ['G0']; serializable: port True, real False; port {}, real {'G-single-item': 1, 'G0': 1}
- undo-faults-seed85.edn: read committed: port True, real True []; serializable: port True, real False; port {}, real {'G-single-item': 1}
- undo-faults-seed87.edn: read committed: port True, real False ['G0']; serializable: port False, real False; port {'G-single': 1}, real {'G-single-item': 1, 'G0': 1}
- undo-faults-seed90.edn: read committed: port True, real False ['G0']; serializable: port False, real False; port {'G-nonadjacent': 1, 'G-single': 1}, real {'G-single-item': 1, 'G0': 1}
- undo-faults-seed95.edn: read committed: port True, real False ['G0']; serializable: port True, real False; port {}, real {'G-single-item': 1, 'G0': 1}
- undo-shuffle-seed11.edn: read committed: port True, real False ['G0']; serializable: port True, real False; port {}, real {'G-single-item': 1, 'G0': 1}
- undo-shuffle-seed38.edn: read committed: port True, real False ['G0']; serializable: port False, real False; port {'G-nonadjacent': 1}, real {'G-single-item': 1, 'G0': 1}
- undo-shuffle-seed54.edn: read committed: port True, real False ['G0']; serializable: port False, real False; port {'G-nonadjacent': 1, 'G-single': 1}, real {'G-single-item': 1, 'G0': 1}
- undo-shuffle-seed74.edn: read committed: port True, real True []; serializable: port True, real False; port {}, real {'G-single-item': 1}
- undo-shuffle-seed85.edn: read committed: port True, real True []; serializable: port True, real False; port {}, real {'G-single-item': 1}
- undo-shuffle-seed87.edn: read committed: port True, real False ['G0']; serializable: port False, real False; port {'G-single': 1}, real {'G-single-item': 1, 'G0': 1}
- undo-shuffle-seed90.edn: read committed: port True, real False ['G0']; serializable: port True, real False; port {}, real {'G-single-item': 1, 'G0': 1}

## Same verdicts, different anomaly types (560 histories), by pattern

| histories | the port's types | real Elle's types (item names mapped) |
|---|---|---|
| 263 | G-nonadjacent, G-single, G0, duplicate-elements | G-single, G0, duplicate-elements |
| 47 | G-nonadjacent, G-single, G1a, incompatible-order | G-single, G1a, incompatible-order |
| 32 | G-nonadjacent, G-single, G1a, incompatible-order | G-single, G0, G1a, incompatible-order |
| 30 | G-nonadjacent, G-single | G-single |
| 23 | G-nonadjacent, G-single, incompatible-order | G-single, G0, incompatible-order |
| 20 | G-nonadjacent, incompatible-order | G-single, G0, incompatible-order |
| 20 | G-nonadjacent, G-single, incompatible-order | G-single, incompatible-order |
| 18 | G-nonadjacent, G1a, incompatible-order | G-single, G0, G1a, incompatible-order |
| 17 | G1a, incompatible-order | G-single, G0, G1a, incompatible-order |
| 17 | G-single, incompatible-order | G-single, G0, incompatible-order |
| 14 | G-nonadjacent, G-single, duplicate-elements | G-single, duplicate-elements |
| 13 | incompatible-order | G-single, G0, incompatible-order |
| 11 | G-nonadjacent, G1a, incompatible-order | G-single, G1a, incompatible-order |
| 8 | G-single, G1a, incompatible-order | G-single, G0, G1a, incompatible-order |
| 7 | G-nonadjacent, G-single, G0 | G-single, G0 |
| 7 | G1a, incompatible-order | G-single, G1a, incompatible-order |
| 4 | incompatible-order | G-single, incompatible-order |
| 3 | G1a | G-single, G0, G1a |
| 2 | G-nonadjacent, incompatible-order | G-single, incompatible-order |
| 2 | G-nonadjacent, G-single, duplicate-elements | G-single, G0, duplicate-elements |
| 1 | G-nonadjacent | G-single |
| 1 | G1a | G-single, G1a |
