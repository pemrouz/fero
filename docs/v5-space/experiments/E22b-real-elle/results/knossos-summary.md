# Knossos 0.3.16 beside Porcupine v1.3.1: every run, per group and mode
| group | mode | partitions | checked by Knossos | both linearizable | both not | differ | Knossos unknown | Knossos ms per op |
|---|---|---|---|---|---|---|---|---|
| register workload (lin-kv), every partition | calm | 600 | 600 | 600 | 0 | 0 | 0 | 2.0 |
| register workload (lin-kv), every partition | faults | 600 | 600 | 600 | 0 | 0 | 0 | 1.6 |
| register workload (lin-kv), every partition | shuffle | 600 | 600 | 600 | 0 | 0 | 0 | 1.5 |
| known-bad: 7 mutant runs, lin-kv before fix G1 | before G1 | 600 | 600 | 599 | 1 | 0 | 0 | 1.8 |
| known-bad: 7 mutant runs, lin-kv before fix G1 | mutant lostcommit | 520 | 520 | 498 | 22 | 0 | 0 | 1.4 |
| known-bad: 7 mutant runs, lin-kv before fix G1 | mutant nodedup | 1680 | 1680 | 1609 | 71 | 0 | 0 | 1.8 |
| every other check, at most 120 ops | calm | 60254 | 60254 | 60254 | 0 | 0 | 0 | 4.2 |
| every other check, at most 120 ops | faults | 60254 | 60254 | 60254 | 0 | 0 | 0 | 4.0 |
| every other check, at most 120 ops | shuffle | 60251 | 60251 | 60251 | 0 | 0 | 0 | 3.9 |
| every other check, 677 to 902 ops | calm | 200 | 200 | 200 | 0 | 0 | 0 | 0.2 |
| every other check, 677 to 902 ops | faults | 200 | 200 | 200 | 0 | 0 | 0 | 0.2 |
| every other check, 677 to 902 ops | shuffle | 200 | 200 | 200 | 0 | 0 | 0 | 0.2 |
| **all** | | 185959 | 185959 | 185865 | 94 | 0 | 0 | 2.7 |

Porcupine found 94 of 185959 partitions not linearizable; Knossos checked 185959 (1566400 operations, 1.16 h of Knossos time).
