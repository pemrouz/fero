| run | module set | distinct states | depth | queue left | verdict | wall s |
|---|---|---|---|---|---|---|
| staleconfig | jar | 172 | 64 | 0 | violates MoreThanOneLeaderInv | 3 |
| staleconfig | stubs | 172 | 64 | 0 | violates MoreThanOneLeaderInv | 4 |
| stale2 | jar | 51 | 34 | 0 | complete, no violation | 6 |
| stale2 | stubs | 51 | 34 | 0 | complete, no violation | 7 |
| stale2 | jartext | 4 | 4 | 0 | TLC error: Error: TLC threw an unexpected exception. | 2458 |
| stale2 | jartext-bagstub | 51 | 34 | 0 | complete, no violation | 4 |
| stale2-mutant | jar | 71 | 54 | 0 | violates MoreThanOneLeaderInv | 4 |
| stale2-mutant | stubs | 71 | 54 | 0 | violates MoreThanOneLeaderInv | 4 |
| r21-script | jar | 79 | 73 | 0 | violates NotGoal | 4 |
| r21-script | stubs | 79 | 73 | 0 | violates NotGoal | 4 |
| r21-append-ef | jar | 2905 | 22 | 0 | complete, no violation | 15 |
| r21-append-ef | stubs | 2905 | 22 | 0 | complete, no violation | 11 |
| r21-append-ef | jartext | 14 | 4 | 9 | TLC error: Error: TLC threw an unexpected exception. | 4 |
| r21-append-ef | jartext-bagstub | 2905 | 22 | 0 | complete, no violation | 13 |
| shipped-asis | jar | 1097543 | 12 | 786181 | stopped at cap | 283 |
| shipped-asis | stubs | 779930 | 12 | 557978 | stopped at cap | 282 |
