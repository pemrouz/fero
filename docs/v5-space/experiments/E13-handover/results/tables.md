| part | setting | events | longest gap between acks, ms | first new write acked after the event, ms | longest logical write (retries in), ms | quiet-window gap, ms | quiet p99, ms |
|---|---|---|---|---|---|---|---|
| move | election 1000 ms | 15 events in 3 runs | 9.8 (4.9-24.4) | 2.0 (1.2-6.0) | 2002.3 (9.8-2006.5) | 5.5 (4.4-22.9) | 4.0 (3.9-6.3) |
| kill | election 1000 ms | 3 events in 3 runs | 1547.0 (1034.9-2002.3) | 1547.9 (1036.2-2004.8) | 2008.4 (2007.2-2011.5) | 5.2 (5.2-6.9) | 4.3 (4.1-4.6) |
| kill | election 2000 ms | 3 events in 3 runs | 4003.9 (4003.6-4004.9) | 4005.2 (4004.9-4006.0) | 4010.7 (4010.0-4011.6) | 4.4 (4.3-7.4) | 3.4 (3.4-3.8) |

| join mode | runs | db size, GB | caught up, s | s per GB of db | load time, s |
|---|---|---|---|---|---|
| log | 3 | 1.04 | 6.0 (5.3-6.2) | 5.7 (5.2-6.0) | 14.8 (13.3-17.3) |
| snap | 3 | 1.03 | 7.1 (3.7-7.1) | 6.8 (3.5-6.9) | 11.4 (11.2-11.5) |
