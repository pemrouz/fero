# E-21 summary

Seeded runs: 30 seeds in each of 7 families (drift, jumpL+, jumpL-, jumpF, pause, crash, mix), 3 or 5 nodes, three minutes of real time each. A rule is needed (DEV-10) when dropping it makes some seed break a check. `stamp.read` (the clock reading) is the world.

## The design runs (counts over every seed)

| option | early_wt | early | late | lease | stuck | back | agree | stale | avail | overlap (sent by a non-holder) | worst late (ms) | worst early (ms) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| wall | 0 | 616 | 2191 | 26 | 11 | 0 | 0 | 0 | 0 | 110 | 158000 | 29900 |
| clamp | 0 | 314 | 290 | 0 | 0 | 0 | 0 | 0 | 0 | 33 | 600 | 600 |
| hlc | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 27 | 300 | 200 |
| mono | 0 | 0 | 583 | 0 | 3 | 0 | 0 | 0 | 0 | 33 | 30000 | 0 |
| mono+ck | 0 | 0 | 341 | 0 | 0 | 0 | 0 | 0 | 0 | 33 | 1100 | 0 |
| tt | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 30 | 300 | 0 |

## Rules (DEV-10)

| option | holds as designed | rules needed | of written | by role | mutants caught / not "no change" |
|---|---|---|---|---|---|
| wall | no: ['jumpL+', 0, ['early', 'lease']] | **5** | 5 | fence 1, log 1, time 3 | 0 / 0 |
| clamp | no: ['jumpL+', 0, ['early']] | **10** | 10 | elect 1, fence 1, log 1, time 7 | 0 / 0 |
| hlc | yes | **6** | 14 | elect 2, fence 1, log 1, time 2 | 6 / 6 |
| mono | no: ['pause', 0, ['late']] | **6** | 6 | fence 1, log 1, time 4 | 0 / 0 |
| mono+ck | no: ['pause', 0, ['late']] | **8** | 8 | fence 1, log 1, time 6 | 0 / 0 |
| tt | yes | **4** | 5 | fence 1, log 1, time 2 | 4 / 4 |

### wall

Fails as designed: first failure ['jumpL+', 0, ['early', 'lease']] (family, seed, checks).

| rule | role | dropped alone breaks (family, seed, checks) | needed in the smallest set |
|---|---|---|---|
| `stamp.never_back` | time | ['jumpL+', 0, ['early', 'lease']] | - |
| `expire.due` | time | ['drift', 0, ['early_wt', 'early']] | - |
| `expire.log` | log | ['drift', 0, ['agree']] | - |
| `grant.lapsed` | time | ['drift', 0, ['lease']] | - |
| `pwrite.fence` | fence | ['drift', 17, ['stale']] | - |

### clamp

Fails as designed: first failure ['jumpL+', 0, ['early']] (family, seed, checks).

| rule | role | dropped alone breaks (family, seed, checks) | needed in the smallest set |
|---|---|---|---|
| `stamp.peers` | time | ['jumpL+', 0, ['early']] | - |
| `stamp.extrap` | time | ['jumpL+', 0, ['late']] | - |
| `stamp.upper` | time | ['jumpL+', 0, ['early', 'lease']] | - |
| `stamp.lower` | time | ['jumpL+', 0, ['early']] | - |
| `stamp.never_back` | time | ['jumpL+', 0, ['early']] | - |
| `expire.due` | time | ['drift', 0, ['early_wt', 'early']] | - |
| `expire.log` | log | ['drift', 0, ['agree']] | - |
| `grant.lapsed` | time | ['drift', 0, ['lease']] | - |
| `stand.near` | elect | ['jumpL+', 0, ['early']] | - |
| `pwrite.fence` | fence | ['drift', 17, ['stale']] | - |

### hlc

| rule | role | dropped alone breaks (family, seed, checks) | needed in the smallest set |
|---|---|---|---|
| `stamp.hlc_max` | time | nothing | False |
| `stamp.never_back` | time | nothing | False |
| `stamp.set_l` | time | nothing | False |
| `send.send_max` | time | ['jumpL+', 23, ['late']] | False |
| `recv.near` | time | ['jumpL+', 0, ['early']] | False |
| `recv.adopt` | time | nothing | False |
| `apply.apply` | time | nothing | False |
| `selffence.far` | elect | ['crash', 18, ['avail']] | ['crash', 18, ['avail']] |
| `selffence.stepdown` | elect | ['jumpL+', 0, ['early', 'lease']] | ['jumpL+', 0, ['early', 'lease']] |
| `stand.near` | elect | nothing | False |
| `expire.due` | time | ['drift', 0, ['early_wt', 'early']] | ['drift', 0, ['early_wt', 'early']] |
| `expire.log` | log | ['drift', 6, ['agree']] | ['drift', 0, ['agree']] |
| `grant.lapsed` | time | ['drift', 0, ['lease']] | ['drift', 0, ['lease']] |
| `pwrite.fence` | fence | ['drift', 17, ['stale']] | ['drift', 17, ['stale']] |

Dropped by the ablation: `stamp.hlc_max`, `stamp.never_back`, `stamp.set_l`, `recv.adopt`, `apply.apply`, `stand.near`, `send.send_max`, `recv.near`.

| mutant | kind | result |
|---|---|---|
| `selffence.far` | drop | ['crash', 18, ['avail']] |
| `selffence.stepdown` | drop | ['jumpL+', 0, ['early', 'lease']] |
| `expire.due` | drop | ['drift', 0, ['early_wt', 'early']] |
| `expire.log` | drop | ['drift', 0, ['agree']] |
| `grant.lapsed` | drop | ['drift', 0, ['lease']] |
| `pwrite.fence` | drop | ['drift', 17, ['stale']] |
| `expire.due` | flip | no change |
| `grant.lapsed` | flip | no change |
| `pwrite.fence` | flip | no change |

### mono

Fails as designed: first failure ['pause', 0, ['late']] (family, seed, checks).

| rule | role | dropped alone breaks (family, seed, checks) | needed in the smallest set |
|---|---|---|---|
| `stamp.never_back` | time | ['jumpL-', 0, ['back']] | - |
| `expire.due` | time | ['drift', 0, ['early']] | - |
| `expire.log` | log | ['drift', 0, ['agree']] | - |
| `grant.lapsed` | time | ['drift', 0, ['lease']] | - |
| `promote.extend` | time | ['pause', 0, ['late']] | - |
| `pwrite.fence` | fence | ['drift', 17, ['stale']] | - |

### mono+ck

Fails as designed: first failure ['pause', 0, ['late']] (family, seed, checks).

| rule | role | dropped alone breaks (family, seed, checks) | needed in the smallest set |
|---|---|---|---|
| `stamp.never_back` | time | ['jumpL-', 0, ['back']] | - |
| `expire.due` | time | ['drift', 0, ['early']] | - |
| `expire.log` | log | ['drift', 0, ['agree']] | - |
| `grant.lapsed` | time | ['drift', 0, ['lease']] | - |
| `promote.extend` | time | ['pause', 0, ['late']] | - |
| `pwrite.fence` | fence | ['drift', 17, ['stale']] | - |
| `ckpt.ckpt` | time | ['pause', 0, ['late']] | - |
| `resume.resume` | time | ['pause', 0, ['late']] | - |

### tt

| rule | role | dropped alone breaks (family, seed, checks) | needed in the smallest set |
|---|---|---|---|
| `stamp.never_back` | time | nothing | False |
| `expire.due` | time | ['drift', 0, ['early_wt', 'early']] | ['drift', 0, ['early_wt', 'early']] |
| `expire.log` | log | ['jumpF', 3, ['agree']] | ['jumpF', 3, ['agree']] |
| `grant.lapsed` | time | ['drift', 0, ['lease']] | ['drift', 0, ['lease']] |
| `pwrite.fence` | fence | ['drift', 17, ['stale']] | ['drift', 17, ['stale']] |

Dropped by the ablation: `stamp.never_back`.

| mutant | kind | result |
|---|---|---|
| `expire.due` | drop | ['drift', 0, ['early_wt', 'early']] |
| `expire.log` | drop | ['jumpF', 3, ['agree']] |
| `grant.lapsed` | drop | ['drift', 0, ['lease']] |
| `pwrite.fence` | drop | ['drift', 17, ['stale']] |
| `expire.due` | flip | no change |
| `grant.lapsed` | flip | no change |
| `pwrite.fence` | flip | no change |
