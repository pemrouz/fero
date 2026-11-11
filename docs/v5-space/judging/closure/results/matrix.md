# Decision matrix over every judged row

Built by `python3 tools/closure_matrix.py` from the 31 judged rows (the study's 20 and the 11 the closure pass judged, [hybrids/cards.json](../hybrids/cards.json)). Each line is the winner by the judging rule under one mix of the user's open choices. "Open MUSTs first" is not the rule as written: it ranks only the rows with the fewest open MUSTs, then applies rule 3, to show what the rule's blind spot decides.

| Reading of the requirements | PERF-01: JetStream's default row accepted as a loss | DATA-01: data's own code must fold on servers | Rule 3 as written | Rule 3, open MUSTs first |
|---|---|---|---|---|
| AMENDMENTS 1.3 restated | no | no (DATA-09's test path) | TiKV-TS (0 novel, 4 SHOULDs, 244 pairs, 122 open) | COMP2 (3 novel, 6 SHOULDs, 277 pairs, 99 open); COMP2 V=full (3 novel, 6 SHOULDs, 277 pairs, 99 open) |
| AMENDMENTS 1.3 restated | no | yes | COMP2 (3 novel, 6 SHOULDs, 277 pairs, 99 open); COMP2 V=full (3 novel, 6 SHOULDs, 277 pairs, 99 open) | COMP2 (3 novel, 6 SHOULDs, 277 pairs, 99 open); COMP2 V=full (3 novel, 6 SHOULDs, 277 pairs, 99 open) |
| AMENDMENTS 1.3 restated | yes | no (DATA-09's test path) | TiKV-persisted (0 novel, 5 SHOULDs, 233 pairs, 121 open) | MIN-TS (4 novel, 5 SHOULDs, 253 pairs, 95 open) |
| AMENDMENTS 1.3 restated | yes | yes | MIN-P+par (3 novel, 6 SHOULDs, 264 pairs, 96 open); MIN-P+par V=full (3 novel, 6 SHOULDs, 264 pairs, 96 open) | MIN-TS (4 novel, 5 SHOULDs, 253 pairs, 95 open) |
| as worded | no | no (DATA-09's test path) | all out; rule 2: DRAFT, SPLIT, ISR, PD+fix, TiKV-TS | all out; rule 2: DRAFT, SPLIT, ISR, PD+fix, TiKV-TS |
| as worded | no | yes | all out; rule 2: DRAFT, SPLIT, ISR | all out; rule 2: DRAFT, SPLIT, ISR |
| as worded | yes | no (DATA-09's test path) | all out; rule 2: DRAFT, SRV, SPLIT, ISR, SLOG, RLOG, EMB-V8, SRV V=full Y=fwd, PD+fix, TiKV-TS, TiKV-persisted | all out; rule 2: DRAFT, SRV, SPLIT, ISR, SLOG, RLOG, EMB-V8, SRV V=full Y=fwd, PD+fix, TiKV-TS, TiKV-persisted |
| as worded | yes | yes | all out; rule 2: DRAFT, SPLIT, ISR, SLOG, RLOG, EMB-V8 | all out; rule 2: DRAFT, SPLIT, ISR, SLOG, RLOG, EMB-V8 |
