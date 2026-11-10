# Do the replacement invariants still catch real bugs? (tools/bugs.py)

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
