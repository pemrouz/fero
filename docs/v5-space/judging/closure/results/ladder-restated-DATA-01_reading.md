# Support ladder: restated, choices: DATA-01 reading

Built by `python3 tools/closure_ladders.py`. Rule 3 among the rows that are in, as more cells that no judged row supports are allowed (the judged rows include the closure pass's, judging/closure/hybrids/cards.json). Columns: novel / SHOULDs / pairs / open MUSTs.

Scenario: restated, choices DATA-01 reading. 381087 rows searched, 17774 in.

| At most this many unsupported cells (every cap; a run of caps with the same result is one line) | Rows in | Rule 3 unbeaten | novel / SHOULDs / pairs / open MUSTs | Unsupported cells of the first |
|---|---|---|---|---|
| 0 | 96 | COMP2; COMP2 H=both; COMP2 H=srv; COMP2 U=cli H=srv; COMP2 V=full; COMP2 V=full H=both (+2 more) | 3 / 6 / 277 / 99 |  |
| 1 | 272 | COMP2; COMP2 H=both; COMP2 H=both L=ts; COMP2 H=srv; COMP2 H=srv L=ts; COMP2 L=rs+napi I=raft-rs (+9 more) | 3 / 6 / 277 / 99 |  |
| 2 | 415 | COMP2; COMP2 H=both; COMP2 H=both L=ts; COMP2 H=srv; COMP2 H=srv L=ts; COMP2 L=rs+napi I=raft-rs (+10 more) | 3 / 6 / 277 / 99 |  |
| 3 | 528 | COMP2; COMP2 H=both; COMP2 H=both L=ts; COMP2 H=srv; COMP2 H=srv L=ts; COMP2 L=rs+napi I=raft-rs (+16 more) | 3 / 6 / 277 / 99 |  |
| 4 to 47 | 620 to 17774 | none: rule 3 goes round in a circle | | |

The first rows at each step (in a circle, the rows ordered by novel count within one of the fewest, then SHOULDs, then pairs; that order is a display aid, not rule 3):

- at most 0: COMP2 (3/6/277, 0 unsupported); COMP2 H=both (3/6/277, 0 unsupported); COMP2 H=srv (3/6/277, 0 unsupported); COMP2 U=cli H=srv (3/6/277, 0 unsupported); COMP2 V=full (3/6/277, 0 unsupported); COMP2 V=full H=both (3/6/277, 0 unsupported)
- at most 1: COMP2 (3/6/277, 0 unsupported); COMP2 H=both (3/6/277, 0 unsupported); COMP2 H=both L=ts (3/6/277, 1 unsupported); COMP2 H=srv (3/6/277, 0 unsupported); COMP2 H=srv L=ts (3/6/277, 1 unsupported); COMP2 L=rs+napi I=raft-rs (3/6/277, 1 unsupported)
- at most 2: COMP2 (3/6/277, 0 unsupported); COMP2 H=both (3/6/277, 0 unsupported); COMP2 H=both L=ts (3/6/277, 1 unsupported); COMP2 H=srv (3/6/277, 0 unsupported); COMP2 H=srv L=ts (3/6/277, 1 unsupported); COMP2 L=rs+napi I=raft-rs (3/6/277, 1 unsupported)
- at most 3: COMP2 (3/6/277, 0 unsupported); COMP2 H=both (3/6/277, 0 unsupported); COMP2 H=both L=ts (3/6/277, 1 unsupported); COMP2 H=srv (3/6/277, 0 unsupported); COMP2 H=srv L=ts (3/6/277, 1 unsupported); COMP2 L=rs+napi I=raft-rs (3/6/277, 1 unsupported)
- at most 4 to 47: H2 G=shard C=cent S=lsm +tier W=any L=ts Z=par (1/5/248, 19 unsupported); H2 G=shard C=cent S=lsm +tier W=any Z=par (1/5/248, 17 unsupported); H2 G=shard C=cent V=full S=lsm +tier W=any L=rs+napi I=raft-rs Z=par (1/5/248, 18 unsupported); H2 G=shard C=cent V=full S=lsm +tier W=any L=ts Z=par (1/5/248, 18 unsupported); H2 G=shard C=cent V=full S=lsm +tier W=any Z=par (1/5/248, 16 unsupported); H2 G=shard C=cent V=full X=ktxn S=lsm +tier W=any L=rs+napi I=raft-rs Z=par (1/5/248, 22 unsupported)
