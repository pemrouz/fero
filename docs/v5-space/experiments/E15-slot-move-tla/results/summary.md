## The plan

| Variants | Runs in the plan | Done on both | Same verdict | Same states | Same steps |
|---|---|---|---|---|---|
| `design`, `fixed` | 11 | 11 | 11 | 11 | 11 |
| the six readings | 18 | 18 | 18 | 18 | 18 |
| the 18 mutants | 47 | 45 | 45 | 45 | 45 |
| **all** | **76** | **74** | **74** | **74** | **74** |

Not run on both: `no-exporting moves` (slot_move.py only); `no-exporting three` (slot_move.py only).

## The 18 mutants

| Mutant | Bounds run on both | slot_move.py: fails | TLC: fails | Same |
|---|---|---|---|---|
| `table-after-open` | move, write | 9 | 9 | yes |
| `recovery-trusts-table` | move, write | none | none | yes |
| `abort-keeps-table` | move, write | 1, 9 | 1, 9 | yes |
| `a-unfences-alone` | move, write | 1, 2, 4, 5, 6, 9 | 1, 2, 4, 5, 6, 9 | yes |
| `no-exporting` | move, write (and moves, three in slot_move.py only) | 7 | 7 | yes |
| `ready-before-copy-commits` | move, write | 7 | 7 | yes |
| `fence-without-ready` | move, write | 7 | 7 | yes |
| `stream-before-fence-commits` | move, write | 1, 2, 3, 4, 5, 6, 7, 9 | 1, 2, 3, 4, 5, 6, 7, 9 | yes |
| `b-serves-before-open-commits` | move, write, dedup, deep | none | none | yes |
| `b-serves-before-open` | move, write, deep | 2, 4, 5, 6 | 2, 4, 5, 6 | yes |
| `fence-N-from-committed` | move, write, deep | 2, 3, 4, 6, 7 | 2, 3, 4, 6, 7 | yes |
| `stamp-from-committed` | move, write, deep | 3, 4, 6 | 3, 4, 6 | yes |
| `no-carried-sequence` | move, write, deep | 2, 6 | 2, 6 | yes |
| `no-carried-outcomes` | move, write, dedup | 5 | 5 | yes |
| `no-max-merge` | move, write, dedup | 5 | 5 | yes |
| `unfence-on-appended-abort` | move, write | 1, 2, 4, 5, 6, 7, 9 | 1, 2, 4, 5, 6, 7, 9 | yes |
| `b-aborts-after-open` | move, write | 4 | 4 | yes |
| `guards-on-committed` | move, write, deep | 1, 2, 4, 5, 6, 9 | 1, 2, 4, 5, 6, 9 | yes |

## DEV-10 mechanical mutants

| Kind | Made | Run | caught | ill-formed | unbounded | survived | equivalent |
|---|---|---|---|---|---|---|---|
| G: drop a guard conjunct | 111 | 111 | 15 | 8 | 6 | 28 | 54 |
| C: flip a comparison | 16 | 16 | 4 | 0 | 1 | 2 | 9 |
| U: drop a state update | 27 | 27 | 16 | 0 | 0 | 10 | 1 |
| **all** | **154** | **154** | **35** | **8** | **7** | **40** | **64** |

- caught / run: 35/154 = 23%
- caught / (run - equivalent): 35/90 = 39%
- (caught + ill-formed + unbounded) / (run - equivalent): 50/90 = 56%
- rules (DEV-10 (c): G and U mutants whose removal a checker catches): 31
- caught on: move 30, write0 5
- caught by: 7 15, Inv1 1, Inv3 1, Inv4 2, Inv6 1, Inv6-step 1, Inv9 14
- the uncaught, by the bounds they ran on: move,moves,write,write0: 1; move,write0: 103
