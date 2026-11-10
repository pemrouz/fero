# E-14c tables (made by tools/table.py)

## Runs (steps 1 and 3)

"model": full is MCferoc.tla as E-14b bounded it; "bounds" are MCferoq.tla's (1 to 4) and MCferoz.tla's (5 and 6), which apply only above the judged term; "grow first" is MCferog.tla's healing-order rule. "plan" is E-14b's plan goal; where the model has the budget flag, it is judged where the change budget still allows the plan, and the last column counts the states where the leader had spent it.

| run | scenario | model | settings | segments | wall s | distinct | depth | finished | violated | AG EF | stuck with a live majority (judged) | plan | plan: cannot finish (judged) | budget spent (not judged) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| four | four | full | MaxTermLimit=4, Plan=swap | 3 | 4,506 | 3,576,095 | 62 | no |  |  |  |  |  |  |
| four-g | four | bounds 1 to 6, grow first | MaxTermLimit=4, Plan=swap | 1 | 550 | 283,449 | 161 | yes |  | PASS | 0 (235,702) | PASS | 0 (53,165) | 0 |
| four-q | four | bounds 1+2 | MaxTermLimit=4, Plan=swap | 1 | 1,502 | 1,588,531 | 55 | no |  |  |  |  |  |  |
| four-qf | four | bounds 1 to 4 | MaxTermLimit=4, Plan=swap | 2 | 2,473 | 1,647,447 | 70 | no: stopped by hand in its second segment: the queue was still growing (bounds 1 to 4 are not enough) |  |  |  |  |  |  |
| four-t2 | four | full | MaxTermLimit=2, Plan=swap | 1 | 356 | 485,043 | 73 | yes |  | FAIL | 22,118 (485,043) | FAIL | 19,952 (109,327) |  |
| four-z | four | bounds 1 to 6 | MaxTermLimit=4, Plan=swap | 1 | 826 | 569,488 | 161 | yes |  | FAIL | 692 (485,043) | PASS | 0 (89,375) | 19,952 |
| one | one | full | MaxTermLimit=4, Plan=grow | 1 | 244 | 194,788 | 110 | yes |  | FAIL | 88 (14,816) | PASS | 0 (4,162) |  |
| one-q | one | bounds 1 | MaxTermLimit=4, Plan=grow | 1 | 186 | 178,256 | 115 | yes |  | FAIL | 88 (14,816) | PASS | 0 (4,162) | 0 |
| one-qf | one | bounds 1 to 4 | MaxTermLimit=4, Plan=grow | 1 | 87 | 78,741 | 113 | yes |  | FAIL | 88 (14,816) | PASS | 0 (4,162) | 0 |
| one-z | one | bounds 1 to 6 | MaxTermLimit=4, Plan=grow | 1 | 24 | 19,654 | 77 | yes |  | FAIL | 88 (14,816) | PASS | 0 (4,162) | 0 |
| three-1c | three | full | FaultLimit=0, MaxTermLimit=4, Plan=all, ReconfigurationLimit=1 | 1 | 32 | 12,098 | 80 | yes |  | PASS | 0 (2,464) | PASS | 0 (2,464) |  |
| three-1c1f | three | full | FaultLimit=1, MaxTermLimit=4, Plan=all, ReconfigurationLimit=1 | 1 | 541 | 579,252 | 126 | yes |  | PASS | 0 (9,024) | PASS | 0 (2,464) |  |
| three-1c1f-d | three | full | AllowLoseDisk=True, FaultLimit=1, MaxTermLimit=4, Plan=all, ReconfigurationLimit=1 | 1 | 319 | 599,466 | 126 | yes |  | PASS | 0 (11,850) | PASS | 0 (2,464) |  |
| three-1c1f-dz | three | bounds 1 to 6 | AllowLoseDisk=True, FaultLimit=1, MaxTermLimit=4, Plan=all, ReconfigurationLimit=1 | 1 | 21 | 23,537 | 107 | yes |  | PASS | 0 (11,850) | PASS | 0 (2,464) | 0 |
| three-1c1f-q | three | bounds 1 | FaultLimit=1, MaxTermLimit=4, Plan=all, ReconfigurationLimit=1 | 1 | 409 | 366,544 | 126 | yes |  | PASS | 0 (9,024) | PASS | 0 (2,464) | 0 |
| three-1c1f-qf | three | bounds 1 to 4 | FaultLimit=1, MaxTermLimit=4, Plan=all, ReconfigurationLimit=1 | 1 | 208 | 167,892 | 121 | yes |  | PASS | 0 (9,024) | PASS | 0 (2,464) | 0 |
| three-1c1f-z | three | bounds 1 to 6 | FaultLimit=1, MaxTermLimit=4, Plan=all, ReconfigurationLimit=1 | 1 | 20 | 18,613 | 107 | yes |  | PASS | 0 (9,024) | PASS | 0 (2,464) | 0 |
| three-disk | three+spare | full | AllowLoseDisk=True, MaxTermLimit=4, Plan=replace | 4 | 6,008 | 4,584,001 | 71 | no |  |  |  |  |  |  |
| three-disk-g | three+spare | bounds 1 to 6, grow first | AllowLoseDisk=True, MaxTermLimit=4, Plan=replace | 1 | 750 | 437,510 | 149 | yes |  | PASS | 0 (340,671) | PASS | 0 (59,627) | 0 |
| three-disk-q | three+spare | bounds 1+2 | AllowLoseDisk=True, MaxTermLimit=4, Plan=replace | 1 | 1,265 | 1,365,470 | 63 | no: killed at 21 min by the session memory limit (three TLC runs at once); not resumed |  |  |  |  |  |  |
| three-disk-qf | three+spare | bounds 1 to 4 | AllowLoseDisk=True, MaxTermLimit=4, Plan=replace | 2 | 2,659 | 1,684,062 | 78 | no: stopped by hand in its second segment: the queue was still growing (bounds 1 to 4 are not enough) |  |  |  |  |  |  |
| three-disk-t2 | three+spare | full | AllowLoseDisk=True, MaxTermLimit=2, Plan=replace | 1 | 302 | 381,270 | 75 | yes |  | FAIL | 67,328 (381,270) | FAIL | 19,399 (65,639) |  |
| three-disk-z | three+spare | bounds 1 to 6 | AllowLoseDisk=True, MaxTermLimit=4, Plan=replace | 1 | 773 | 493,907 | 149 | yes |  | FAIL | 112 (381,270) | PASS | 0 (63,001) | 2,638 |
| two | two | full | FaultLimit=1, MaxTermLimit=4, Plan=stepback, ReconfigurationLimit=2 | 1 | 693 | 597,181 | 141 | yes |  | FAIL | 6 (17,014) | PASS | 0 (4,759) |  |
| two-1c1f | two | full | FaultLimit=1, MaxTermLimit=4, Plan=stepback, ReconfigurationLimit=1 | 1 | 92 | 66,344 | 124 | yes |  | FAIL | 4 (2,090) | PASS | 0 (572) |  |
| two-1c1f-d | two | full | AllowLoseDisk=True, FaultLimit=1, MaxTermLimit=4, Plan=stepback, ReconfigurationLimit=1 | 1 | 50 | 67,725 | 124 | yes |  | FAIL | 4 (2,776) | PASS | 0 (572) |  |
| two-1c1f-dz | two | bounds 1 to 6 | AllowLoseDisk=True, FaultLimit=1, MaxTermLimit=4, Plan=stepback, ReconfigurationLimit=1 | 1 | 9 | 4,286 | 85 | yes |  | FAIL | 4 (2,776) | PASS | 0 (572) | 0 |
| two-1c1f-q | two | bounds 1 | FaultLimit=1, MaxTermLimit=4, Plan=stepback, ReconfigurationLimit=1 | 1 | 73 | 60,866 | 124 | yes |  | FAIL | 4 (2,090) | PASS | 0 (572) | 0 |
| two-1c1f-qc | two | bounds 1+2 | FaultLimit=1, MaxTermLimit=4, Plan=stepback, ReconfigurationLimit=1 | 1 | 57 | 49,143 | 124 | yes |  | FAIL | 4 (2,090) | PASS | 0 (572) | 0 |
| two-1c1f-qf | two | bounds 1 to 4 | FaultLimit=1, MaxTermLimit=4, Plan=stepback, ReconfigurationLimit=1 | 1 | 52 | 28,030 | 121 | yes |  | FAIL | 4 (2,090) | PASS | 0 (572) | 0 |
| two-1c1f-z | two | bounds 1 to 6 | FaultLimit=1, MaxTermLimit=4, Plan=stepback, ReconfigurationLimit=1 | 1 | 6 | 3,460 | 85 | yes |  | FAIL | 4 (2,090) | PASS | 0 (572) | 0 |
| two-qc | two | bounds 1+2 | FaultLimit=1, MaxTermLimit=4, Plan=stepback, ReconfigurationLimit=2 | 1 | 288 | 248,647 | 144 | yes |  | FAIL | 6 (17,014) | PASS | 0 (4,759) | 0 |
| two-qf | two | bounds 1 to 4 | FaultLimit=1, MaxTermLimit=4, Plan=stepback, ReconfigurationLimit=2 | 1 | 195 | 154,752 | 144 | yes |  | FAIL | 6 (17,014) | PASS | 0 (4,759) | 0 |
| two-z | two | bounds 1 to 6 | FaultLimit=1, MaxTermLimit=4, Plan=stepback, ReconfigurationLimit=2 | 1 | 25 | 22,507 | 127 | yes |  | FAIL | 6 (17,014) | PASS | 0 (4,759) | 0 |

## The reduced runs against the full runs' part-graphs (tools/partial.py)

| reduced run (finished) | full run (part-graph) | states in both | with a flag different | judged states of the full run missing in the reduced | reduced steps out of states the full run expanded | of which the full run lacks | judged with a live majority: not shown to reach a working leader, reduced alone | in the union |
|---|---|---|---|---|---|---|---|---|
| {'edges': 760826, 'ends_not_written': 0, 'judged': 485043, 'judged_live': 452004, 'not_shown': 22118, 'plan_judged': 109327, 'plan_not_shown': 19952, 'plan_reach': 89375, 'reach_goal': 429886, 'states': 485043} (485,043) | {'edges': 5364664, 'ends_not_written': 0, 'judged': 453346, 'judged_live': 420816, 'not_shown': 31343, 'plan_judged': 104092, 'plan_not_shown': 21628, 'plan_reach': 82464, 'reach_goal': 389473, 'states': 3576095} (3,576,095) | 453,346 | 0 | 0 | 701,665 | 0 | 22,118 | 21,907 |
| {'edges': 612422, 'ends_not_written': 0, 'judged': 381270, 'judged_live': 376950, 'not_shown': 67328, 'plan_judged': 65639, 'plan_not_shown': 19399, 'plan_reach': 46240, 'reach_goal': 309622, 'states': 381270} (381,270) | {'edges': 6652225, 'ends_not_written': 0, 'judged': 380528, 'judged_live': 376198, 'not_shown': 62764, 'plan_judged': 65583, 'plan_not_shown': 19111, 'plan_reach': 46472, 'reach_goal': 313434, 'states': 4584001} (4,584,001) | 380,518 | 0 | 10 | 610,403 | 0 | 67,328 | 62,450 |

## r19 (step 4)

rule: `/\ i \in GetConfig(i)      \* [g]`; mutant: `/\ TRUE      \* mutant: guard dropped`

| run | distinct | finished | violated | judged at term | AG EF | stuck with a live majority (judged) | plan |
|---|---|---|---|---|---|---|---|
| design-m2p-t5 | 572 | yes |  | 3 | PASS | 0 (572) | PASS |
| design-m3-t5 | 12,098 | yes |  | 3 | FAIL | 812 (12,098) | FAIL |
| r19-m2p-t5 | 572 | yes |  | 3 | PASS | 0 (572) | PASS |
| r19-m3-t5 | 87,779 | yes |  | 3 | FAIL | 6,340 (24,302) | FAIL |

## Bugs (step 2)

Planted bugs: one row per invariant set checked (the set named, alone). Mutants: E-14's
DEV-10 mutants, checked with the new set (MCferoc.tla) on the scenario named.

| bug | invariants checked, or scenario | result | first violated | trace (states) | distinct states |
|---|---|---|---|---|---|
| anylog | CommittedNeverLostInv | complete, none violated |  |  | 737138 |
| anylog | CommittedQuorumInv | violated | CommittedQuorumInv | 36 | 54081 |
| anylog | LeaderCompletenessRaftInv | violated | LeaderCompletenessRaftInv | 27 | 18501 |
| anylog | LogInv | violated | LogInv | 39 | 70583 |
| anylog | VoteQuorumInv | violated | VoteQuorumInv | 27 | 18326 |
| anylog | new | violated | VoteQuorumInv | 27 | 17693 |
| anylog | shipped | violated | MoreUpToDateCorrectInv | 27 | 17763 |
| design (no mutant) | m2 (new set) | complete, none violated; AG EF PASS (0 stuck), plan PASS |  |  | 100736 |
| ghost | CommittedNeverLostInv | violated | CommittedNeverLostInv | 41 | 106102 |
| ghost | CommittedQuorumInv | violated | CommittedQuorumInv | 15 | 4282 |
| ghost | LeaderCompletenessRaftInv | violated | LeaderCompletenessRaftInv | 32 | 46976 |
| ghost | LogInv | violated | LogInv | 44 | 125223 |
| ghost | VoteQuorumInv | violated | VoteQuorumInv | 15 | 4342 |
| ghost | new | violated | VoteQuorumInv | 15 | 4095 |
| ghost | shipped | violated | QuorumLogInvLive | 15 | 4374 |
| minority | CommittedNeverLostInv | complete, none violated |  |  | 1033203 |
| minority | CommittedQuorumInv | violated | CommittedQuorumInv | 7 | 319 |
| minority | LeaderCompletenessRaftInv | violated | LeaderCompletenessRaftInv | 20 | 11564 |
| minority | LogInv | violated | LogInv | 25 | 27242 |
| minority | VoteQuorumInv | violated | VoteQuorumInv | 7 | 335 |
| minority | new | violated | VoteQuorumInv | 7 | 323 |
| minority | shipped | violated | QuorumLogInvLive | 7 | 334 |
| FeroBecomeLeader:drop-update-pendingConfChangeIndex:r02 | m2 (new set) | violated | CommittedQuorumInv | 56 | 44440 |
| ProposeConf:drop-guard:r05 | m2 (new set) | violated | CommittedQuorumInv | 20 | 12201 |
| ProposeConf:drop-guard:r06 | m2 (new set) | violated | CommittedQuorumInv | 23 | 2652 |
| ProposeConf:drop-update-pendingConfChangeIndex:r09 | m2 (new set) | violated | CommittedQuorumInv | 20 | 12424 |
| twovote | CommittedNeverLostInv | complete, none violated |  |  | 708862 |
| twovote | CommittedQuorumInv | complete, none violated |  |  | 708862 |
| twovote | LeaderCompletenessRaftInv | complete, none violated |  |  | 708862 |
| twovote | LogInv | complete, none violated |  |  | 708862 |
| twovote | VoteQuorumInv | complete, none violated |  |  | 708862 |
| twovote | new | violated | MoreThanOneLeaderInv | 40 | 75494 |
| twovote | shipped | violated | MoreThanOneLeaderInv | 40 | 75999 |
