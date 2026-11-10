## The rules added at the crossing (every other rule kept)

Bounds: `src`, `dst`, `read-src`, `read-dst`, `mark-src`, `mark-dst`, `remit-src`, `remit-dst`, `lock-src`, `lock-dst`, `giveup-src`, `giveup-dst`, `crash-src`, `crash-dst`, `floors-src`, `floors-dst`, `floore-src`, `floore-dst`.

Pinned (written, never dropped, not counted): `write.floor`, `snap.cut`.

| Rule | What it says | Dropped alone | In the smallest set | Kept because |
|---|---|---|---|---|
| `write.above` | E-20 sess: apply only at or above the session's floor | P3 on `floore-src` in 7 steps | **needed** | P3 on `floore-src` in 7 steps |
| `write.mark` | E-30 srchi-slot: a derived output applies only above the slot's mark | P8 on `remit-src` in 4 steps | **needed** | P8 on `remit-src` in 4 steps |
| `write.src` | E-30 srchi-slot: the source sequence is written in the output's own entry | P8 on `remit-src` in 4 steps | **needed** | P8 on `remit-src` in 4 steps |
| `refuse.above` | E-20 sess: a copy below the floor is answered stale, never judged; E-17's refusal reads the outcomes, and E-20 forgets them below the floor | P3 on `floors-src` in 6 steps | **needed** | P3 on `floors-src` in 6 steps |
| `final.floor` | E-20 sess: the session's floor | P3 on `floors-src` in 18 steps | **needed** | P3 on `floors-src` in 18 steps |
| `final.mark` | E-30 srchi-slot: the slot's mark | P8 on `remit-src` in 16 steps | **needed** | P8 on `remit-src` in 16 steps |
| `snap.com` | a snapshot is cut at or below the commit offset | P1 on `src` in 2 steps | **needed** | P1 on `src` in 2 steps |
| `snap.nomove` | DESIGN-V5 4.1: no slot move is still copying from it | nothing breaks | dropped |  |
| `snap.held` | which slots the group holds open | P6 on `src` in 13 steps | **needed** | P6 on `src` in 13 steps |
| `snap.seq` | each slot's sequence | P2 on `mark-src` in 5 steps | **needed** | P2 on `mark-src` in 5 steps |
| `snap.recs` | each slot's rows and records | P1 on `src` in 3 steps | **needed** | P1 on `src` in 3 steps |
| `snap.outs` | each slot's dedup outcomes | P3 on `src` in 5 steps | **needed** | P3 on `src` in 5 steps |
| `snap.floor` | the session floor | P3 on `floors-src` in 7 steps | **needed** | P3 on `floors-src` in 7 steps |
| `snap.tok` | each slot's highest lock token | P3 on `lock-src` in 5 steps | **needed** | P3 on `lock-src` in 5 steps |
| `snap.mark` | each slot's srchi-slot mark | P8 on `remit-src` in 5 steps | **needed** | P8 on `remit-src` in 5 steps |
| `snap.cfg` | the group's config | CF on `src` in 5 steps | **needed** | CF on `src` in 5 steps |
| `snap.f_exp` | the moves this group exports | no counterexample; the search stopped at the state limit on `giveup-src` (1,100,261 states) | **needed** | P1 on `src` in 21 steps |
| `snap.f_imp` | the moves this group imports | nothing breaks | dropped |  |
| `snap.f_cp` | which copies it holds, and their END | P1 on `dst` in 17 steps | **needed** | P1 on `dst` in 19 steps |
| `snap.f_fen` | its fences, with N | L7 on `giveup-src` in 12 steps | **needed** | L5 on `src` in 9 steps |
| `snap.f_can` | its cancels | nothing breaks | dropped |  |
| `snap.f_unf` | its unfences | nothing breaks | dropped |  |
| `snap.f_open` | its opens | P6 on `giveup-dst` in 17 steps | **needed** | P6 on `giveup-dst` in 19 steps |
| `snap.f_abort` | its aborts | P6 on `giveup-dst` in 17 steps | **needed** | P6 on `giveup-dst` in 17 steps |

Needed: 20 of 24. Greedy order (model text): `snap.nomove` dropped; `snap.f_imp` dropped; `snap.f_can` dropped; `snap.f_unf` dropped

