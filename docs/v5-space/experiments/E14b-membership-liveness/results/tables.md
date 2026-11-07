## Calibration

| run | rule | scenario and bounds | reductions | distinct states | depth | judged states | result | wall s |
|---|---|---|---|---|---|---|---|---|
| r21-append-none | on append | 4V+0L, plan demote, 0 changes, no fault, terms <= 4, R2-1 state | none | 2,905 | 22 | 1 | stuck states with a live majority: 1 (FAIL); plan cannot finish: 1 (FAIL) | 4 (1 seg) |
| r21-append-rb | on append | 4V+0L, plan demote, 0 changes, no fault, terms <= 4, R2-1 state | R1+R2 | 135 | 16 | 1 | stuck states with a live majority: 1 (FAIL); plan cannot finish: 1 (FAIL) | 5 (1 seg) |
| r21-append | on append | 4V+0L, plan demote, 0 changes, no fault, terms <= 4, R2-1 state | R1+R2+R3+R4 | 135 | 16 | 1 | stuck states with a live majority: 1 (FAIL); plan cannot finish: 1 (FAIL) | 1 (1 seg) |
| r21-rb | on commit | 4V+0L, plan demote, 0 changes, no fault, terms <= 4, R2-1 state | R1+R2 | 91,576 | 117 | 1 | stuck states with a live majority: 0 (PASS); plan cannot finish: 0 (PASS) | 160 (1 seg) |
| r21 | on commit | 4V+0L, plan demote, 0 changes, no fault, terms <= 4, R2-1 state | R1+R2+R3+R4 | 3,603 | 111 | 1 | stuck states with a live majority: 0 (PASS); plan cannot finish: 0 (PASS) | 6 (1 seg) |
| r21f-rb | on commit | 4V+0L, plan demote, 0 changes, 1 fault (crash), terms <= 4, R2-1 state | R1+R2 | 1,143,532 | 120 | 5 | stuck states with a live majority: 0 (PASS); plan cannot finish: 0 (PASS) | 1379 (1 seg) |
| r21f | on commit | 4V+0L, plan demote, 0 changes, 1 fault (crash), terms <= 4, R2-1 state | R1+R2+R3+R4 | 25,175 | 113 | 5 | stuck states with a live majority: 0 (PASS); plan cannot finish: 0 (PASS) | 55 (1 seg) |
| three-1c-rbd | on commit | 3V+0L, plan all, 1 change, no fault, terms <= 4, leader in place | R1+R2+R3 | 2,698,102 | 84 | 10,736 | stuck states with a live majority: 0 (PASS); plan cannot finish: 0 (PASS) | 1289 (1 seg) |
| three-1c | on commit | 3V+0L, plan all, 1 change, no fault, terms <= 4, leader in place | R1+R2+R3+R4 | 12,098 | 80 | 2,464 | stuck states with a live majority: 0 (PASS); plan cannot finish: 0 (PASS) | 7 (1 seg) |
| three-1c1f | on commit | 3V+0L, plan all, 1 change, 1 fault (crash), terms <= 4, leader in place | R1+R2+R3+R4 | 555,676 | 126 | 9,024 | stuck states with a live majority: 0 (PASS); plan cannot finish: 0 (PASS) | 559 (1 seg) |
| two-1c1f | on commit | 2V+1L, plan stepback, 1 change, 1 fault (crash), terms <= 4, leader in place | R1+R2+R3+R4 | 64,245 | 124 | 2,090 | stuck states with a live majority: 4 (FAIL); plan cannot finish: 0 (PASS) | 75 (1 seg) |
| two-1c1f-append | on append | 2V+1L, plan stepback, 1 change, 1 fault (crash), terms <= 4, leader in place | R1+R2+R3+R4 | 79,641 | 113 | 3,273 | stuck states with a live majority: 0 (PASS); plan cannot finish: 0 (PASS) | 99 (1 seg) |
| two-1c1f-novote | on commit, learners refuse votes | 2V+1L, plan stepback, 1 change, 1 fault (crash), terms <= 4, leader in place | R1+R2+R3+R4 | 59,775 | 124 | 2,090 | stuck states with a live majority: 16 (FAIL); plan cannot finish: 0 (PASS) | 84 (1 seg) |

## Sweep

| run | rule | scenario and bounds | reductions | distinct states | depth | judged states | result | wall s |
|---|---|---|---|---|---|---|---|---|
| four-voters | on commit | 4V+0L, plan demote, 1 change, 1 fault (crash), terms <= 4, leader in place | R1+R2+R3+R4 | 5,165,341 | 169 | 18,414 | stuck states with a live majority: 0 (PASS); plan cannot finish: 0 (PASS) | 5491 (4 seg) |
| two | on commit | 2V+1L, plan stepback, 2 changes, 1 fault (crash), terms <= 4, leader in place | R1+R2+R3+R4 | 558,605 | 141 | 17,014 | stuck states with a live majority: 6 (FAIL); plan cannot finish: 0 (PASS) | 382 (1 seg) |
| one | on commit | 1V+2L, plan grow, 2 changes, 1 fault (crash), terms <= 4, leader in place | R1+R2+R3+R4 | 111,597 | 64 |  | invariant **QuorumLogInvLive** broken | 52 (1 seg) |
| one-noq | on commit | 1V+2L, plan grow, 2 changes, 1 fault (crash), terms <= 4, leader in place | R1+R2+R3+R4 | 190,058 | 110 | 14,816 | stuck states with a live majority: 88 (FAIL); plan cannot finish: 0 (PASS) | 169 (1 seg) |
| three-disk | on commit | 3V+0L+1 spare, plan replace, 2 changes, 1 fault (crash or lost disk), terms <= 4, leader in place | R1+R2+R3+R4 | 2,736,260 | 66 |  | invariant **LeaderCompletenessInv** broken | 2365 (2 seg) |
| four-voters-append | on append | 4V+0L, plan demote, 1 change, 1 fault (crash), terms <= 4, leader in place | R1+R2+R3+R4 | 677,790 | 60 |  | invariant **LeaderCompletenessInv** broken | 727 (1 seg) |
| three-ghost | on commit, lost disk returns under its old id | 3V+0L, plan all, 1 change, 1 fault (crash or lost disk), terms <= 4, leader in place | R1+R2+R3+R4 | 4,019 | 16 |  | invariant **QuorumLogInvLive** broken | 10 (1 seg) |
| three-ghost-loss | on commit, lost disk returns under its old id | 3V+0L, plan all, 1 change, 1 fault (crash or lost disk), terms <= 4, leader in place | R1+R2+R3+R4 | 54,270 | 34 |  | invariant **MoreUpToDateCorrectInv** broken | 22 (1 seg) |
