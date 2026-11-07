| run | bound | slot_move.md | slot_move.py here | TLC here | same |
|---|---|---|---|---|---|
| design | move | 47,754: 1 (20), 9 (15) | 47,754: 1 (20), 9 (15) | 47,754: 1 (20), 9 (15) | yes |
| design | moves | 530,385: 1 (20), 9 (15) | 530,385: 1 (20), 9 (15) | 530,385: 1 (20), 9 (15) | yes |
| design | write | 1,251,562: 1 (20), 6 (26), 9 (15) | 1,251,562: 1 (20), 6 (26), 9 (15) | 1,251,562: 1 (20), 6 (26), 9 (15) | yes |
| design | dedup | 327,308: all hold | 327,308: all hold | 327,308: all hold | yes |
| design | deep | 286,188: all hold | 286,188: all hold | 286,188: all hold | yes |
| fixed | move | 47,457: all hold | 47,457: all hold | 47,457: all hold | yes |
| fixed | moves | 898,312: all hold | 898,312: all hold | 898,312: all hold | yes |
| fixed | write | 1,107,824: all hold | 1,107,824: all hold | 1,107,824: all hold | yes |
| fixed | dedup | 351,262: all hold | 351,262: all hold | 351,262: all hold | yes |
| fixed | deep | 308,274: all hold | 308,274: all hold | 308,274: all hold | yes |
| fixed | three | 7,510,764: all hold | 7,510,764: all hold | — | no |
| fixed-but-recovery-resumes | move | 71,784: 9 (19) | 71,784: 9 (19) | 71,784: 9 (19) | yes |
| fixed-but-recovery-resumes | moves | 1,175,418: 1 (32), 9 (19) | 1,175,418: 1 (32), 9 (19) | 1,175,418: 1 (32), 9 (19) | yes |
| fixed-but-recovery-resumes | write | 1,835,310: 9 (19) | 1,835,310: 9 (19) | 1,835,310: 9 (19) | yes |
| fixed-but-table-by-writer | move | 24,474: 9 (16) | 24,474: 9 (16) | 24,474: 9 (16) | yes |
| fixed-but-table-by-writer | moves | 309,780: 9 (16) | 309,780: 9 (16) | 309,780: 9 (16) | yes |
| fixed-but-table-by-writer | write | 579,576: 9 (16) | 579,576: 9 (16) | 579,576: 9 (16) | yes |
| fixed-but-table-unversioned | move | 31,713: 1 (19), 9 (15) | 31,713: 1 (19), 9 (15) | 31,713: 1 (19), 9 (15) | yes |
| fixed-but-table-unversioned | moves | 598,753: 1 (19), 9 (15) | 598,753: 1 (19), 9 (15) | 598,753: 1 (19), 9 (15) | yes |
| fixed-but-table-unversioned | write | 746,372: 1 (19), 9 (15) | 746,372: 1 (19), 9 (15) | 746,372: 1 (19), 9 (15) | yes |
| fixed-but-recovery-reads-table-only | move | 48,981: 9 (15) | 48,981: 9 (15) | 48,981: 9 (15) | yes |
| fixed-but-recovery-reads-table-only | moves | 948,381: 9 (15) | 948,381: 9 (15) | 948,381: 9 (15) | yes |
| fixed-but-recovery-reads-table-only | write | 1,158,978: 9 (15) | 1,158,978: 9 (15) | 1,158,978: 9 (15) | yes |
| fixed-but-fence-ignores-incarnation | move | 55,197: 1 (23), 9 (21) | 55,197: 1 (23), 9 (21) | 55,197: 1 (23), 9 (21) | yes |
| fixed-but-fence-ignores-incarnation | moves | 1,088,268: 1 (23), 9 (21) | 1,088,268: 1 (23), 9 (21) | 1,088,268: 1 (23), 9 (21) | yes |
| fixed-but-fence-ignores-incarnation | write | 1,318,048: 1 (23), 9 (21) | 1,318,048: 1 (23), 9 (21) | 1,318,048: 1 (23), 9 (21) | yes |
| fixed-but-unfence-at-old-epoch | move | 45,837: all hold | 45,837: all hold | 45,837: all hold | yes |
| fixed-but-unfence-at-old-epoch | moves | 869,816: all hold | 869,816: all hold | 869,816: all hold | yes |
| fixed-but-unfence-at-old-epoch | write | 1,069,440: 6 (25) | 1,069,440: 6 (25) | 1,069,440: 6 (25) | yes |

28 of 29 rows the same in all three.

| mutant | slot_move.md: caught by | slot_move.py here, full runs | TLC here | note |
|---|---|---|---|---|
| table-after-open | 9 | 9 | 9 |  |
| recovery-trusts-table | not caught |  |  |  |
| abort-keeps-table | 1, 9 | 1, 9 | 1, 9 |  |
| a-unfences-alone | 1, 9 | 1, 2, 4, 5, 6, 9 | 1, 2, 4, 5, 6, 9 | more than slot_move.md: 2, 4, 5, 6 |
| no-exporting | 1, 7, 9 | 1, 6, 7, 9 | (not all run) | more than slot_move.md: 6 |
| ready-before-copy-commits | 7 | 7 | 7 |  |
| fence-without-ready | 7 | 7 | 7 |  |
| stream-before-fence-commits | 1, 2, 3, 4, 5, 6, 7, 9 | 1, 2, 3, 4, 5, 6, 7, 9 | 1, 2, 3, 4, 5, 6, 7, 9 |  |
| b-serves-before-open-commits | not caught |  |  |  |
| b-serves-before-open | 2, 4, 5, 6 | 2, 4, 5, 6 | 2, 4, 5, 6 |  |
| fence-N-from-committed | 2, 3, 4, 6, 7 | 2, 3, 4, 6, 7 | 2, 3, 4, 6, 7 |  |
| stamp-from-committed | 3, 4, 6 | 3, 4, 6 | 3, 4, 6 |  |
| no-carried-sequence | 2, 6 | 2, 6 | 2, 6 |  |
| no-carried-outcomes | 5 | 5 | 5 |  |
| no-max-merge | 5 | 5 | 5 |  |
| unfence-on-appended-abort | 1, 7, 9 | 1, 2, 4, 5, 6, 7, 9 | 1, 2, 4, 5, 6, 7, 9 | more than slot_move.md: 2, 4, 5, 6 |
| b-aborts-after-open | 4 | 4 | 4 |  |
| guards-on-committed | 1, 2, 4, 5, 6, 9 | 1, 2, 4, 5, 6, 9 | 1, 2, 4, 5, 6, 9 |  |
