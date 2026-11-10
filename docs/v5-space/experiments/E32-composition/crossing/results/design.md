| Bound | What it holds | States | Steps | Judged for liveness | Seconds | Explored | Result |
|---|---|---|---|---|---|---|---|
| `src` | w1; member 0 loses its disk (never back); heals: A; 1 drop at A | 26,724 | 53,747 | 26,724 | 6 | in full | every property holds |
| `dst` | w1; member 1 loses its disk (never back); heals: B; 1 drop at B | 36,716 | 67,875 | 36,716 | 7 | in full | every property holds |
| `src-dst` | w1; member 0 loses its disk (never back); heals: B; 1 drop at B | 47,204 | 104,335 | 47,204 | 10 | in full | every property holds |
| `dst-src` | w1; member 1 loses its disk (never back); heals: A; 1 drop at A | 30,882 | 67,151 | 30,882 | 6 | in full | every property holds |
| `mark-src` | o1, o2; member 0 loses its disk (never back); heals: A; 1 drop at A; derived outputs | 56,196 | 93,333 | 56,196 | 11 | in full | every property holds |
| `mark-dst` | o1, o2; member 1 loses its disk (never back); heals: B; 1 drop at B; derived outputs | 63,438 | 97,675 | 63,438 | 13 | in full | every property holds |
| `read-src` | w1; member 0 loses its disk (never back); heals: A; 1 drop at A; a reader | 49,360 | 146,219 | 49,360 | 10 | in full | every property holds |
| `read-dst` | w1; member 1 loses its disk (never back); heals: B; 1 drop at B; a reader | 66,036 | 179,059 | 66,036 | 14 | in full | every property holds |
| `giveup-src` | w1; member 0 loses its disk (never back); heals: A; 1 drop at A; B may give up | 110,026 | 223,547 | 110,026 | 23 | in full | every property holds |
| `giveup-dst` | w1; member 1 loses its disk (never back); heals: B; 1 drop at B; B may give up | 139,182 | 301,447 | 139,182 | 30 | in full | every property holds |
| `crash-src` | w1; member 0 crashes (may come back); heals: A; 1 drop at A | 162,142 | 422,400 | 162,142 | 35 | in full | every property holds |
| `crash-dst` | w1; member 1 crashes (may come back); heals: B; 1 drop at B | 239,782 | 594,267 | 239,782 | 53 | in full | every property holds |
| `floor-src` | w1, w2; member 0 loses its disk (never back); heals: A; 1 drop at A; rising lock tokens | 323,504 | 766,693 | 323,504 | 72 | in full | every property holds |
| `floor-dst` | w1, w2; member 1 loses its disk (never back); heals: B; 1 drop at B; rising lock tokens | 350,768 | 773,793 | 350,768 | 77 | in full | every property holds |
| `floors-src` | w1, w2; member 0 loses its disk (never back); heals: A; 1 drop at A; one write at a time, rising lock tokens | 176,560 | 358,609 | 176,560 | 41 | in full | every property holds |
| `floors-dst` | w1, w2; member 1 loses its disk (never back); heals: B; 1 drop at B; one write at a time, rising lock tokens | 183,536 | 341,089 | 183,536 | 43 | in full | every property holds |
| `twice-src` | w1; member 0 loses its disk (never back); heals: A; 1 drop at A; moves to B and back | 336,916 | 628,516 | 336,916 | 75 | in full | every property holds |
| `twice-dst` | w1; member 1 loses its disk (never back); heals: B; 1 drop at B; moves to B and back | 511,554 | 931,076 | 511,554 | 114 | in full | every property holds |
| `slots-src` | w1, w3; member 0 loses its disk (never back); heals: A; 1 drop at A; one write at a time, one write on the moving slot, one on the slot that stays | 264,308 | 558,593 | 264,308 | 60 | in full | every property holds |
| `slots-dst` | w1, w3; member 1 loses its disk (never back); heals: B; 1 drop at B; one write at a time, one write on the moving slot, one on the slot that stays | 234,540 | 478,917 | 234,540 | 53 | in full | every property holds |
| `floore-src` | w1, w2; member 0 loses its disk (never back); heals: A; 1 drop at A; one write at a time, equal lock tokens | 176,560 | 358,609 | 176,560 | 39 | in full | every property holds |
| `floore-dst` | w1, w2; member 1 loses its disk (never back); heals: B; 1 drop at B; one write at a time, equal lock tokens | 183,536 | 341,089 | 183,536 | 40 | in full | every property holds |
| `remit-src` | o1, o1r; member 0 loses its disk (never back); heals: A; 1 drop at A; derived outputs, one re-emitted under a new id | 51,180 | 92,391 | 51,180 | 11 | in full | every property holds |
| `remit-dst` | o1, o1r; member 1 loses its disk (never back); heals: B; 1 drop at B; derived outputs, one re-emitted under a new id | 68,820 | 116,032 | 68,820 | 15 | in full | every property holds |
| `lock-src` | w1, w2; member 0 loses its disk (never back); heals: A; 1 drop at A; two lock holders, no session | 83,272 | 144,241 | 83,272 | 17 | in full | every property holds |
| `lock-dst` | w1, w2; member 1 loses its disk (never back); heals: B; 1 drop at B; two lock holders, no session | 98,734 | 160,663 | 98,734 | 20 | in full | every property holds |
| `heal2-src` | w1; member 0 loses its disk (never back); heals: A, B; 1 drop at A | 1,373,695 | 3,327,956 | 1,373,695 | 407 | in full | every property holds |
| `heal2-dst` | w1; member 1 loses its disk (never back); heals: A, B; 1 drop at B | 2,612,006 | 6,244,395 | 2,612,006 | 856 | in full | every property holds |
| `any` | w1; member 0 or 1 or 2 loses its disk (never back); heals: A, B; 1 drop at A or B | 2,500,001 | 6,003,555 | 0 | 553 | PARTIAL: stopped at the state limit | no counterexample (safety only; liveness not judged) |
| `all` | w1; member 0 or 1 or 2 crashes or loses its disk (may come back); heals: A, B; 2 drop at A or B; a reader, B may give up | 2,500,002 | 7,151,236 | 0 | 381 | PARTIAL: stopped at the state limit | no counterexample (safety only; liveness not judged) |
