| Option | Rules as written | **Necessary** | Beyond fixN | Other greedy order | With a working give-up (of which undecided) | Model lines | Entry kinds the smallest model adds (fields) | Cursor parts | States as written, 6 sweep bounds | States smallest, 6 bounds; twice1 | Seconds, one sweep: as written; smallest | Mutants caught of made (equivalent; survived) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| fixN | 14 | **13** | 0 | - | - | 79 | 0:  | 2 | 220 | 220; 6 | 0; 0.0 | 17 of 18 (1; 0) |
| slot moves | 69 | **26** | 13 | 26 (`slot-rev`) | 33 to 34 † | 363 | 4: `cp` (8), `exp` (2), `fen` (3), `open` (3) | 2 | 202,618 | 12,249; 487 | 51; 0.7 | 35 of 46 (11; 0) |
| fixN + re-key (CELL as written) | 57 | **35** | 22 | 35 (`rekey-rev`); 34 (`rekey-alt`) | 40 to 41 † | 369 | 5: `cp` (7), `cut` (1), `flip` (1), `frz` (1), `rk` (2) | 3 | 1,026,569 | 13,896; 1,147 | 101; 2.5 | 44 of 53 (8; 1) |
| fixN + re-key, positions carried | 51 | **29** | 16 | 29 (`rekey-carry-rev`); 28 (`rekey-carry-alt`) | 34 to 35 † | 369 | 5: `cp` (7), `cut` (1), `flip` (1), `frz` (1), `rk` (2) | 3 | 1,011,043 | 13,371; 1,147 | 140; 1.0 | 38 of 45 (7; 0) |
| pslot (MIN-P) | 80 | **30** | 17 | 30 (`pslot-rev`) | 38 to 40 † | 402 | 4: `cp` (8), `exp` (2), `fen` (3), `open` (3) | 3 | 202,618 | 12,249; 487 | 49; 0.7 | 43 of 59 (16; 0) |
| split + merge (SPLIT) | 47 | **33** | 20 | 33 (`split-rev`) | 39 | 294 | 5: `init` (7), `mgd` (7), `mrg` (2), `spl` (3), `sub` (2) | 3 | 3,473 | 2,244; 209 | 1; 0.3 | 46 of 59 (13; 0) |
| lanes + range moves (LANE) | 68 | **28** | 15 | 28 (`lanes-rev`) | 36 to 37 † | 368 | 4: `cp` (8), `exp` (2), `fen` (3), `open` (2) | 3 | 202,618 | 12,298; 660 | 37; 0.5 | 39 of 50 (11; 0) |
| lanes, records carried | 67 | **26** | 13 | - | - | 368 | 4: `cp` (8), `exp` (2), `fen` (3), `open` (2) | 3 | 202,618 | 12,249; 487 | 28; 1.1 | 35 of 46 (11; 0) |
| probe: pslot-fused | 35 | **24** | 11 | 24 (`pslot-fused-rev`) | 31 | 235 | 2: `cp` (6), `fen` (3) | 3 | 15,603 | 1,982; 115 | 3; 0.3 | 34 of 45 (11; 0) |

† the original set (parts 1 and 2), checked fresh by verify.py, not re-derived. A range counts the rules still undecided at the state limit (kept).
