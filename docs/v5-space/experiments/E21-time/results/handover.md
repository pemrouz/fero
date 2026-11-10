# E-21: the verify family `handover`

`drift` plus 2 to 6 planned handovers per run, 30 seeds, 3 or 5 nodes (made by `sim/verify.py`). A handover: the leader stamps its last entry, another member takes over and stamps the next in the same tick.

| option | as designed | worst early (ms) | worst late (ms) | smallest model of the seven families | rule put back | rules needed now | mutants caught / not "no change" (eight families) |
|---|---|---|---|---|---|---|---|
| `wall` | holds | 200 | 300 | (fails as designed on the seven) | - | - | - |
| `clamp` | holds | 200 | 300 | (fails as designed on the seven) | - | - | - |
| `median` | holds | 0 | 100 | back 48 (worst step back 0.101 ms) | `stamp.never_back` | 8 | 15 / 15 (3 of them by an evaluation error) |
| `median1` | holds | 0 | 100 | back 48 (worst step back 0.101 ms) | `stamp.never_back` | 7 | 12 / 12 (1 of them by an evaluation error) |
| `hlc` | holds | 0 | 300 | back 66 (worst step back 248.64 ms) | `stamp.never_back` | 7 | 8 / 8 (1 of them by an evaluation error) |
| `mono` | late 1468, stuck 3 | 0 | 93400 | (fails as designed on the seven) | - | - | - |
| `mono+ck` | late 1324, lease 2 | 0 | 2900 | (fails as designed on the seven) | - | - | - |
| `tt` | holds | 0 | 300 | holds | none | 4 | 4 / 4 |

## median: each rule of the new smallest model dropped on top (eight families)

| rule | breaks (family, seed, checks) |
|---|---|
| `stamp.extrap` | ('jumpL+', 0, ['early', 'lease']) |
| `stamp.upper` | ('jumpL+', 0, ['early', 'lease']) |
| `stamp.lower` | ('jumpL-', 0, ['late']) |
| `expire.due` | ('drift', 0, ['early_wt', 'early']) |
| `expire.log` | ('drift', 2, ['agree']) |
| `grant.lapsed` | ('drift', 0, ['lease']) |
| `pwrite.fence` | ('drift', 17, ['stale']) |
| `stamp.never_back` | ('handover', 0, ['back']) |

Put back alone on the old smallest model (latest dropped first): `stand.near` ('handover', 0, ['back']), `stamp.never_back` holds, `stamp.peers` ('handover', 0, ['back']).

| mutant | kind | result |
|---|---|---|
| `stamp.extrap` | drop | ('jumpL+', 0, ['early', 'lease']) |
| `stamp.upper` | drop | ('jumpL+', 0, ['early', 'lease']) |
| `stamp.lower` | drop | ('jumpL-', 0, ['late']) |
| `stamp.never_back` | drop | ('handover', 0, ['back']) |
| `expire.due` | drop | ('drift', 0, ['early_wt', 'early']) |
| `expire.log` | drop | ('drift', 2, ['agree']) |
| `grant.lapsed` | drop | ('drift', 0, ['lease']) |
| `pwrite.fence` | drop | ('drift', 17, ['stale']) |
| `expire.due` | flip | no change |
| `grant.lapsed` | flip | no change |
| `pwrite.fence` | flip | no change |
| `stamp: extrap <-> upper` | swap | ('jumpL+', 0, ['early', 'lease']) |
| `stamp: extrap <-> lower` | swap | ('jumpL+', 0, ['early', 'lease']) |
| `stamp: extrap <-> never_back` | swap | ('jumpL+', 0, ['early', 'lease']) |
| `stamp: upper <-> lower` | swap | no change |
| `stamp: upper <-> never_back` | swap | ('handover', 0, ['back']) |
| `stamp: lower <-> never_back` | swap | no change |
| `stamp: read <-> extrap` | swap | no change |
| `stamp: read <-> upper` | swap | ('drift', 0, ['ERR']) |
| `stamp: read <-> lower` | swap | ('drift', 0, ['ERR']) |
| `stamp: read <-> never_back` | swap | ('drift', 0, ['ERR']) |

## median1: each rule of the new smallest model dropped on top (eight families)

| rule | breaks (family, seed, checks) |
|---|---|
| `stamp.extrap` | ('jumpL+', 0, ['early', 'lease']) |
| `stamp.median` | ('jumpL+', 0, ['early', 'lease']) |
| `expire.due` | ('drift', 0, ['early_wt', 'early']) |
| `expire.log` | ('drift', 2, ['agree']) |
| `grant.lapsed` | ('drift', 0, ['lease']) |
| `pwrite.fence` | ('drift', 17, ['stale']) |
| `stamp.never_back` | ('handover', 0, ['back']) |

Put back alone on the old smallest model (latest dropped first): `stand.near` ('handover', 0, ['back']), `stamp.never_back` holds, `stamp.peers` ('handover', 0, ['back']).

| mutant | kind | result |
|---|---|---|
| `stamp.extrap` | drop | ('jumpL+', 0, ['early', 'lease']) |
| `stamp.median` | drop | ('jumpL+', 0, ['early', 'lease']) |
| `stamp.never_back` | drop | ('handover', 0, ['back']) |
| `expire.due` | drop | ('drift', 0, ['early_wt', 'early']) |
| `expire.log` | drop | ('drift', 2, ['agree']) |
| `grant.lapsed` | drop | ('drift', 0, ['lease']) |
| `pwrite.fence` | drop | ('drift', 17, ['stale']) |
| `expire.due` | flip | no change |
| `grant.lapsed` | flip | no change |
| `pwrite.fence` | flip | no change |
| `stamp: extrap <-> median` | swap | ('jumpL+', 0, ['early', 'lease']) |
| `stamp: extrap <-> never_back` | swap | ('jumpL+', 0, ['early', 'lease']) |
| `stamp: median <-> never_back` | swap | ('handover', 0, ['back']) |
| `stamp: read <-> extrap` | swap | no change |
| `stamp: read <-> median` | swap | ('jumpL+', 0, ['early', 'lease']) |
| `stamp: read <-> never_back` | swap | ('drift', 0, ['ERR']) |

## hlc: each rule of the new smallest model dropped on top (eight families)

| rule | breaks (family, seed, checks) |
|---|---|
| `selffence.far` | ('crash', 18, ['avail']) |
| `selffence.stepdown` | ('jumpL+', 0, ['early', 'lease']) |
| `expire.due` | ('drift', 0, ['early_wt', 'early']) |
| `expire.log` | ('drift', 0, ['agree']) |
| `grant.lapsed` | ('drift', 0, ['lease']) |
| `pwrite.fence` | ('drift', 17, ['stale']) |
| `stamp.never_back` | ('handover', 0, ['back']) |

Put back alone on the old smallest model (latest dropped first): `recv.near` ('handover', 0, ['back']), `send.send_max` ('handover', 0, ['back']), `stand.near` ('handover', 0, ['back']), `apply.apply` ('handover', 0, ['back']), `recv.adopt` ('handover', 0, ['back']), `stamp.set_l` ('handover', 0, ['back']), `stamp.never_back` holds, `stamp.hlc_max` ('handover', 0, ['back']).

| mutant | kind | result |
|---|---|---|
| `stamp.never_back` | drop | ('handover', 0, ['back']) |
| `selffence.far` | drop | ('crash', 18, ['avail']) |
| `selffence.stepdown` | drop | ('jumpL+', 0, ['early', 'lease']) |
| `expire.due` | drop | ('drift', 0, ['early_wt', 'early']) |
| `expire.log` | drop | ('drift', 0, ['agree']) |
| `grant.lapsed` | drop | ('drift', 0, ['lease']) |
| `pwrite.fence` | drop | ('drift', 17, ['stale']) |
| `expire.due` | flip | no change |
| `grant.lapsed` | flip | no change |
| `pwrite.fence` | flip | no change |
| `stamp: read <-> never_back` | swap | ('drift', 0, ['ERR']) |

## tt: each rule of the new smallest model dropped on top (eight families)

| rule | breaks (family, seed, checks) |
|---|---|
| `expire.due` | ('drift', 0, ['early_wt', 'early']) |
| `expire.log` | ('jumpF', 3, ['agree']) |
| `grant.lapsed` | ('drift', 0, ['lease']) |
| `pwrite.fence` | ('drift', 17, ['stale']) |

| mutant | kind | result |
|---|---|---|
| `expire.due` | drop | ('drift', 0, ['early_wt', 'early']) |
| `expire.log` | drop | ('jumpF', 3, ['agree']) |
| `grant.lapsed` | drop | ('drift', 0, ['lease']) |
| `pwrite.fence` | drop | ('drift', 17, ['stale']) |
| `expire.due` | flip | no change |
| `grant.lapsed` | flip | no change |
| `pwrite.fence` | flip | no change |
