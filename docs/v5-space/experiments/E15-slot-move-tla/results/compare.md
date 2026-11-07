| run | bound | slot_move.py states / live | TLC states / live | slot_move.py fails (steps) | TLC fails (steps) | same |
|---|---|---|---|---|---|---|
| design | move | 47,754 / 175 | 47,754 / 175 | 1 (20), 9 (15) | 1 (20), 9 (15) | yes |
| fixed | move | 47,457 / 205 | 47,457 / 205 | all hold | all hold | yes |
| fixed-but-recovery-resumes | move | 71,784 / 205 | 71,784 / 205 | 9 (19) | 9 (19) | yes |
| fixed-but-table-by-writer | move | 24,474 / 175 | 24,474 / 175 | 9 (16) | 9 (16) | yes |
| fixed-but-unfence-at-old-epoch | move | 45,837 / 205 | 45,837 / 205 | all hold | all hold | yes |
| fixed-but-recovery-reads-table-only | move | 48,981 / 205 | 48,981 / 205 | 9 (15) | 9 (15) | yes |
| fixed-but-fence-ignores-incarnation | move | 55,197 / 205 | 55,197 / 205 | 1 (23), 9 (21) | 1 (23), 9 (21) | yes |
| fixed-but-table-unversioned | move | 31,713 / 188 | 31,713 / 188 | 1 (19), 9 (15) | 1 (19), 9 (15) | yes |
| table-after-open | move | 43,134 / 180 | 43,134 / 180 | 9 (14) | 9 (14) | yes |
| recovery-trusts-table | move | 48,861 / 205 | 48,861 / 205 | all hold | all hold | yes |
| abort-keeps-table | move | 23,547 / 167 | 23,547 / 167 | 1 (18), 9 (16) | 1 (18), 9 (16) | yes |
| a-unfences-alone | move | 183,068 / 1,789 | 183,068 / 1,789 | 1 (17), 9 (16) | 1 (17), 9 (16) | yes |
| no-exporting | move | 35,743 / 270 | 35,743 / 270 | 7 (3) | 7 | yes |
| ready-before-copy-commits | move | 57,608 / 309 | 57,608 / 309 | 7 (9) | 7 | yes |
| fence-without-ready | move | 79,020 / 249 | 79,020 / 249 | 7 (4) | 7 | yes |
| stream-before-fence-commits | move | 106,679 / 461 | 106,679 / 461 | 1 (14), 7 (12), 9 (12) | 1 (14), 7, 9 (12) | yes |
| b-serves-before-open-commits | move | 47,457 / 205 | 47,457 / 205 | all hold | all hold | yes |
| b-serves-before-open | move | 47,457 / 205 | 47,457 / 205 | all hold | all hold | yes |
| fence-N-from-committed | move | 47,457 / 205 | 47,457 / 205 | all hold | all hold | yes |
| stamp-from-committed | move | 61,876 / 205 | 61,876 / 205 | all hold | all hold | yes |
| no-carried-sequence | move | 47,457 / 205 | 47,457 / 205 | all hold | all hold | yes |
| no-carried-outcomes | move | 47,457 / 205 | 47,457 / 205 | all hold | all hold | yes |
| no-max-merge | move | 47,457 / 205 | 47,457 / 205 | all hold | all hold | yes |
| unfence-on-appended-abort | move | 70,462 / 340 | 70,462 / 340 | 1 (17), 7 (13), 9 (16) | 1 (17), 7, 9 (16) | yes |
| b-aborts-after-open | move | 48,384 / 210 | 48,384 / 210 | all hold | all hold | yes |
| guards-on-committed | move | 50,453 / 256 | 50,453 / 256 | 1 (20), 9 (18) | 1 (20), 9 (18) | yes |
| design | moves | 530,385 / 2,354 | 530,385 / 2,354 | 1 (20), 9 (15) | 1 (20), 9 (15) | yes |
| fixed | moves | 898,312 / 3,694 | 898,312 / 3,694 | all hold | all hold | yes |
| fixed-but-recovery-resumes | moves | 1,175,418 / 3,694 | 1,175,418 / 3,694 | 1 (32), 9 (19) | 1 (32), 9 (19) | yes |
| fixed-but-table-by-writer | moves | 309,780 / 2,354 | 309,780 / 2,354 | 9 (16) | 9 (16) | yes |
| fixed-but-unfence-at-old-epoch | moves | 869,816 / 3,694 | 869,816 / 3,694 | all hold | all hold | yes |
| fixed-but-recovery-reads-table-only | moves | 948,381 / 3,694 | 948,381 / 3,694 | 9 (15) | 9 (15) | yes |
| fixed-but-fence-ignores-incarnation | moves | 1,088,268 / 3,694 | 1,088,268 / 3,694 | 1 (23), 9 (21) | 1 (23), 9 (21) | yes |
| fixed-but-table-unversioned | moves | 598,753 / 2,749 | 598,753 / 2,749 | 1 (19), 9 (15) | 1 (19), 9 (15) | yes |
| no-exporting | moves | 14,724,097 / 31,798 | — | 1 (20), 6 (24), 7 (3), 9 (18) | — |  |
| design | write | 1,251,562 / 1,484 | 1,251,562 / 1,484 | 1 (20), 6 (26), 9 (15) | 1 (20), 6 (26), 9 (15) | yes |
| fixed | write | 1,107,824 / 1,725 | 1,107,824 / 1,725 | all hold | all hold | yes |
| fixed-but-recovery-resumes | write | 1,835,310 / 1,725 | 1,835,310 / 1,725 | 9 (19) | 9 (19) | yes |
| fixed-but-table-by-writer | write | 579,576 / 1,484 | 579,576 / 1,484 | 9 (16) | 9 (16) | yes |
| fixed-but-unfence-at-old-epoch | write | 1,069,440 / 1,725 | 1,069,440 / 1,725 | 6 (25) | 6 (25) | yes |
| fixed-but-recovery-reads-table-only | write | 1,158,978 / 1,725 | 1,158,978 / 1,725 | 9 (15) | 9 (15) | yes |
| fixed-but-fence-ignores-incarnation | write | 1,318,048 / 1,725 | 1,318,048 / 1,725 | 1 (23), 9 (21) | 1 (23), 9 (21) | yes |
| fixed-but-table-unversioned | write | 746,372 / 1,564 | 746,372 / 1,564 | 1 (19), 9 (15) | 1 (19), 9 (15) | yes |
| table-after-open | write | 1,006,920 / 1,580 | 1,006,920 / 1,580 | 9 (14) | 9 (14) | yes |
| recovery-trusts-table | write | 1,168,836 / 1,725 | 1,168,836 / 1,725 | all hold | all hold | yes |
| abort-keeps-table | write | 554,754 / 1,436 | 554,754 / 1,436 | 1 (18), 9 (16) | 1 (18), 9 (16) | yes |
| a-unfences-alone | write | 3,085,583 / 9,720 | 3,085,583 / 9,720 | 1 (17), 2 (24), 4 (21), 5 (24), 6 (24), 9 (16) | 1 (17), 2 (24), 4 (21), 5 (24), 6 (24), 9 (16) | yes |
| no-exporting | write | 787,217 / 1,768 | 787,217 / 1,768 | 7 (3) | 7 | yes |
| ready-before-copy-commits | write | 1,395,852 / 2,089 | 1,395,852 / 2,089 | 7 (9) | 7 | yes |
| fence-without-ready | write | 1,628,278 / 1,991 | 1,628,278 / 1,991 | 7 (4) | 7 | yes |
| stream-before-fence-commits | write | 2,795,712 / 6,289 | 2,795,712 / 6,289 | 1 (14), 2 (21), 3 (18), 4 (17), 5 (21), 6 (21), 7 (12), 9 (12) | 1 (14), 2 (21), 3 (18), 4 (17), 5 (21), 6 (21), 7, 9 (12) | yes |
| b-serves-before-open-commits | write | 1,114,166 / 1,728 | 1,114,166 / 1,728 | all hold | all hold | yes |
| b-serves-before-open | write | 1,151,124 / 1,778 | 1,151,124 / 1,778 | 2 (23), 4 (15), 5 (22), 6 (18) | 2 (23), 4 (15), 5 (22), 6 (18) | yes |
| fence-N-from-committed | write | 1,352,550 / 2,085 | 1,352,550 / 2,085 | 3 (18), 4 (18), 6 (12), 7 (13) | 3 (18), 4 (18), 6 (12), 7 | yes |
| stamp-from-committed | write | 1,378,740 / 1,725 | 1,378,740 / 1,725 | all hold | all hold | yes |
| no-carried-sequence | write | 1,107,824 / 1,725 | 1,107,824 / 1,725 | all hold | all hold | yes |
| no-carried-outcomes | write | 1,116,592 / 1,737 | 1,116,592 / 1,737 | 5 (21) | 5 (21) | yes |
| no-max-merge | write | 1,107,824 / 1,725 | 1,107,824 / 1,725 | all hold | all hold | yes |
| unfence-on-appended-abort | write | 1,678,551 / 3,122 | 1,678,551 / 3,122 | 1 (17), 2 (25), 4 (22), 5 (25), 6 (25), 7 (13), 9 (16) | 1 (17), 2 (25), 4 (22), 5 (25), 6 (25), 7, 9 (16) | yes |
| b-aborts-after-open | write | 1,137,728 / 1,755 | 1,137,728 / 1,755 | 4 (20) | 4 (20) | yes |
| guards-on-committed | write | 1,517,866 / 2,697 | 1,517,866 / 2,697 | 1 (20), 2 (21), 4 (18), 5 (21), 6 (17), 9 (18) | 1 (20), 2 (21), 4 (18), 5 (21), 6 (17), 9 (18) | yes |
| design | dedup | 327,308 / 5,050 | 327,308 / 5,050 | all hold | all hold | yes |
| fixed | dedup | 351,262 / 5,694 | 351,262 / 5,694 | all hold | all hold | yes |
| no-carried-outcomes | dedup | 353,390 / 5,730 | 353,390 / 5,730 | 5 (21) | 5 (21) | yes |
| no-max-merge | dedup | 352,750 / 5,721 | 352,750 / 5,721 | 5 (24) | 5 (24) | yes |
| b-serves-before-open-commits | dedup | 355,204 / 5,697 | 355,204 / 5,697 | all hold | all hold | yes |
| design | deep | 286,188 / 14,733 | 286,188 / 14,733 | all hold | all hold | yes |
| fixed | deep | 308,274 / 16,923 | 308,274 / 16,923 | all hold | all hold | yes |
| fence-N-from-committed | deep | 411,310 / 24,413 | 411,310 / 24,413 | 2 (21), 3 (18), 4 (18), 6 (12), 7 (13) | 2 (21), 3 (18), 4 (18), 6 (12), 7 | yes |
| stamp-from-committed | deep | 500,268 / 26,681 | 500,268 / 26,681 | 3 (22), 4 (22), 6 (7) | 3 (22), 4 (22), 6 (7) | yes |
| no-carried-sequence | deep | 308,274 / 16,923 | 308,274 / 16,923 | 2 (21), 6 (21) | 2 (21), 6 (21) | yes |
| b-serves-before-open | deep | 322,170 / 17,539 | 322,170 / 17,539 | 2 (23), 4 (15), 6 (18) | 2 (23), 4 (15), 6 (18) | yes |
| b-serves-before-open-commits | deep | 309,016 / 16,961 | 309,016 / 16,961 | all hold | all hold | yes |
| guards-on-committed | deep | 526,891 / 31,856 | 526,891 / 31,856 | 1 (20), 2 (21), 4 (18), 6 (17), 9 (18) | 1 (20), 2 (21), 4 (18), 6 (17), 9 (18) | yes |
| fixed | three | 7,510,764 / 17,819 | 7,510,764 / 17,819 | all hold | all hold | yes |
| no-exporting | three | 6,554,885 / 1,198,769 | — | 7 (3), 9 (18) | — |  |

74 of 76 runs done on both; 74 same verdict; 74 same state counts; 74 same steps.
