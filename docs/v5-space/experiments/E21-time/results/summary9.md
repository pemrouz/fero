# E-21 summary

Seeded runs: 30 seeds in each of 9 families (drift, jumpL+, jumpL-, jumpF, pause, crash, mix, jump2, handover), 3 or 5 nodes, three minutes of real time each. A rule is needed (DEV-10) when dropping it makes some seed break a check. `stamp.read` (the clock reading) is the world.

## The design runs (counts over every seed)

| option | early_wt | early | late | lease | stuck | back | agree | stale | avail | overlap (sent by a non-holder) | worst late (ms) | worst early (ms) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| median+g | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 35 | 300 | 100 |
| hlc | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 29 | 300 | 200 |
| tt | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 32 | 300 | 0 |

## Rules (DEV-10)

| option | holds as designed | rules needed | of written | by role | mutants caught / not "no change" |
|---|---|---|---|---|---|
| median+g | yes | **9** | 11 | elect 2, fence 1, log 1, time 5 | 14 / 14 |
| hlc | yes | **7** | 14 | elect 2, fence 1, log 1, time 3 | 8 / 8 |
| tt | yes | **4** | 5 | fence 1, log 1, time 2 | 4 / 4 |

### median+g

| rule | role | dropped alone breaks (family, seed, checks) | needed in the smallest set |
|---|---|---|---|
| `stamp.peers` | time | nothing | False |
| `stamp.extrap` | time | ['drift', 0, ['late']] | ['jumpL+', 0, ['early', 'lease']] |
| `stamp.median` | time | ['jumpL+', 0, ['early', 'lease']] | ['jumpL+', 0, ['early', 'lease']] |
| `stamp.never_back` | time | ['handover', 0, ['back']] | ['handover', 0, ['back']] |
| `expire.due` | time | ['drift', 0, ['early_wt', 'early']] | ['drift', 0, ['early_wt', 'early']] |
| `expire.log` | log | ['drift', 2, ['agree']] | ['drift', 2, ['agree']] |
| `grant.lapsed` | time | ['drift', 0, ['lease']] | ['drift', 0, ['lease']] |
| `pwrite.fence` | fence | ['drift', 17, ['stale']] | ['drift', 17, ['stale']] |
| `selffence.scattered` | elect | ['crash', 18, ['avail']] | ['crash', 18, ['avail']] |
| `selffence.stepdown` | elect | ['jump2', 0, ['late']] | ['jump2', 0, ['late']] |
| `stand.agree` | elect | nothing | False |

Dropped by the ablation: `stamp.peers`, `stand.agree`.

| mutant | kind | result |
|---|---|---|
| `stamp.extrap` | drop | ['jumpL+', 0, ['early', 'lease']] |
| `stamp.median` | drop | ['jumpL+', 0, ['early', 'lease']] |
| `stamp.never_back` | drop | ['handover', 0, ['back']] |
| `expire.due` | drop | ['drift', 0, ['early_wt', 'early']] |
| `expire.log` | drop | ['drift', 2, ['agree']] |
| `grant.lapsed` | drop | ['drift', 0, ['lease']] |
| `pwrite.fence` | drop | ['drift', 17, ['stale']] |
| `selffence.scattered` | drop | ['crash', 18, ['avail']] |
| `selffence.stepdown` | drop | ['jump2', 0, ['late']] |
| `expire.due` | flip | no change |
| `grant.lapsed` | flip | no change |
| `pwrite.fence` | flip | no change |
| `stamp: extrap <-> median` | swap | ['jumpL+', 0, ['early', 'lease']] |
| `stamp: extrap <-> never_back` | swap | ['jumpL+', 0, ['early', 'lease']] |
| `stamp: median <-> never_back` | swap | ['handover', 0, ['back']] |
| `stamp: read <-> extrap` | swap | no change |
| `stamp: read <-> median` | swap | ['jumpL+', 0, ['early', 'lease']] |
| `stamp: read <-> never_back` | swap | ['drift', 0, ['ERR']] |

### hlc

| rule | role | dropped alone breaks (family, seed, checks) | needed in the smallest set |
|---|---|---|---|
| `stamp.hlc_max` | time | nothing | False |
| `stamp.never_back` | time | nothing | ['handover', 0, ['back']] |
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

Dropped by the ablation: `stamp.hlc_max`, `stamp.set_l`, `recv.adopt`, `apply.apply`, `stand.near`, `send.send_max`, `recv.near`.

| mutant | kind | result |
|---|---|---|
| `stamp.never_back` | drop | ['handover', 0, ['back']] |
| `selffence.far` | drop | ['crash', 18, ['avail']] |
| `selffence.stepdown` | drop | ['jumpL+', 0, ['early', 'lease']] |
| `expire.due` | drop | ['drift', 0, ['early_wt', 'early']] |
| `expire.log` | drop | ['drift', 0, ['agree']] |
| `grant.lapsed` | drop | ['drift', 0, ['lease']] |
| `pwrite.fence` | drop | ['drift', 17, ['stale']] |
| `expire.due` | flip | no change |
| `grant.lapsed` | flip | no change |
| `pwrite.fence` | flip | no change |
| `stamp: read <-> never_back` | swap | ['drift', 0, ['ERR']] |

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
