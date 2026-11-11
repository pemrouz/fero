# The outcome, as arithmetic

Built by `python3 tools/judging.py verdict` from the settled judging files in this folder. Nothing here is written by hand: it applies the judging rule of [REQUIREMENTS.md](../REQUIREMENTS.md) to the cells. [VERDICT.md](../VERDICT.md) explains it.

## 1. How far the two judges agreed

| Group | Cells | Same verdict | Decisive differences | Minor differences | Referee against both |
|---|---|---|---|---|---|
| P | 500 | 409 (81.8%) | 20 | 71 | 0 |
| PERF-DATA | 460 | 371 (80.7%) | 15 | 74 | 0 |
| SC | 300 | 265 (88.3%) | 22 | 13 | 0 |
| F | 460 | 432 (93.9%) | 7 | 21 | 0 |
| DEV | 220 | 220 (100.0%) | 0 | 0 | 0 |
| DEP | 460 | 417 (90.7%) | 5 | 38 | 0 |
| TEST-OPS | 560 | 516 (92.1%) | 4 | 40 | 0 |
| **All** | 2960 | 2630 (88.9%) | 73 | 257 | 0 |

A cell is one requirement part for one row. A decisive difference could change the ranking: a MUST that one judge failed and the other did not, or a SHOULD that one counted as met and the other did not. A referee ruled on every difference in writing.

After the VERDICT review a referee re-ruled 64 cells and the mechanism count ([closure/rerulings.cells.json](closure/rerulings.cells.json), [closure/rerulings.mech.json](closure/rerulings.mech.json)). The arithmetic below applies those rulings; the table above counts the first settlement.

Two outcomes follow. [AMENDMENTS.md](../AMENDMENTS.md) section 1.3 lists requirement clauses that the evidence shows no row can meet as worded, and what each experiment asks instead. 169 cells carry two verdicts for that reason: one as the requirement is worded, one as restated. Part A uses the first, part B the second.

## A. As the requirements are worded today

### A.1 Each row

| Row | MUSTs failed by design | MUSTs open | MUSTs met | Novel mechanisms (DEV-01) | SHOULDs met | SHOULDs not met | SHOULDs open | Interacting pairs (DEV-02) |
|---|---|---|---|---|---|---|---|---|
| DRAFT | F-17, SC-03, SC-10 | 98 | 31 | 5 | 5 | 3 | 8 | 309 |
| MIN | F-15, F-17, PERF-04, SC-03, SC-10 | 93 | 34 | 4 | 5 | 4 | 7 | 253 |
| RUST | F-15, F-17, PERF-04, SC-03, SC-10 | 94 | 33 | 4 | 5 | 4 | 7 | 253 |
| SRV | F-17, PERF-04, SC-03, SC-10 | 100 | 28 | 4 | 5 | 4 | 7 | 267 |
| LEAN | F-15, F-17, PERF-04, SC-03, SC-10 | 93 | 34 | 4 | 5 | 4 | 7 | 255 |
| CELL | F-17, OPS-01, P-07, SC-03, SC-08, SC-10 | 99 | 27 | 4 | 5 | 3 | 8 | 277 |
| LANE | F-17, PERF-04, SC-03, SC-04, SC-10 | 95 | 32 | 3 | 5 | 3 | 8 | 232 |
| SPLIT | F-17, SC-03, SC-10 | 100 | 29 | 4 | 5 | 3 | 8 | 295 |
| PD | F-17, F-22, PERF-04, SC-03, SC-05, SC-10 | 114 | 12 | 0 | 4 | 3 | 9 | 218 |
| ISR | SC-03, SC-04, SC-10 | 117 | 12 | 2 | 1 | 2 | 13 | 214 |
| SLOG | F-15, PERF-04, SC-03, SC-10 | 114 | 14 | 5 | 2 | 4 | 10 | 272 |
| OBJ | DEP-21, F-15, P-01, P-05, PERF-04, PERF-07, PERF-08, SC-03, SC-10 | 109 | 14 | 2 | 1 | 3 | 12 | 144 |
| V4 | DATA-01, DATA-07, DEP-02, DEP-05, DEP-12, DEP-18, F-01, F-02, F-03, F-04, F-07, F-08, F-09, F-14, F-21, OPS-01, OPS-03, OPS-05, OPS-06, P-01, P-02, P-05, P-06, P-07, P-08, P-09, P-10, P-11, P-13, P-14, P-15, P-16, P-17, P-20, P-22, PERF-02, PERF-03, PERF-04, PERF-05, PERF-06, PERF-07, PERF-10, PERF-11, PERF-13, SC-03, SC-05, SC-08, SC-10, SC-13, TEST-13 | 64 | 18 | 8 | 2 | 9 | 5 | 52 |
| MIN-P | F-15, F-17, PERF-04, SC-03, SC-10 | 93 | 34 | 3 | 5 | 4 | 7 | 252 |
| MIN-TS | F-15, F-17, PERF-04, SC-03, SC-10 | 91 | 36 | 4 | 5 | 4 | 7 | 253 |
| RLOG | F-17, PERF-04, SC-03, SC-10 | 94 | 34 | 4 | 5 | 3 | 8 | 268 |
| EMB-V8 | F-17, PERF-04, SC-03, SC-10 | 97 | 31 | 4 | 5 | 4 | 7 | 269 |
| SIDE | F-15, F-17, PERF-04, SC-03, SC-10 | 96 | 31 | 4 | 5 | 4 | 7 | 277 |
| BUY | DEP-12, DEP-20, DEV-07, F-02, F-05, F-19, OPS-11, P-06, P-10, P-11, P-14, PERF-02, PERF-03, PERF-04, PERF-05, PERF-06, PERF-07, PERF-10, SC-01, SC-03, SC-05, SC-07, SC-10, TEST-01, TEST-09, TEST-10, TEST-13 | 96 | 9 | 0 | 2 | 7 | 7 | 12 |
| COMP | F-15, F-17, SC-03, SC-10 | 97 | 31 | 3 | 5 | 4 | 7 | 283 |

### A.2 The ranking

Every row fails at least one MUST, so rule 2 applies: fewest MUSTs failed first, then the smaller sum of gap over bar. Level first, on both counts: DRAFT, SPLIT, ISR. Rule 2 names no further tie-break.

| Place | Row | MUSTs failed | Sum of gap over bar |
|---|---|---|---|
| 1 | DRAFT | 3 | 1.32 |
| 1 | SPLIT | 3 | 1.32 |
| 1 | ISR | 3 | 1.32 |
| 4 | COMP | 4 | 1.32 |
| 5 | SRV | 4 | 1.39 |
| 5 | SLOG | 4 | 1.39 |
| 5 | RLOG | 4 | 1.39 |
| 5 | EMB-V8 | 4 | 1.39 |
| 9 | MIN | 5 | 1.39 |
| 9 | RUST | 5 | 1.39 |
| 9 | LEAN | 5 | 1.39 |
| 9 | LANE | 5 | 1.39 |
| 9 | MIN-P | 5 | 1.39 |
| 9 | MIN-TS | 5 | 1.39 |
| 9 | SIDE | 5 | 1.39 |
| 16 | PD | 6 | 1.39 |
| 17 | CELL | 6 | 1.54 |
| 18 | OBJ | 9 | 18.08 |
| 19 | BUY | 27 | 8.79 |
| 20 | V4 | 50 | 10.04 |

### A.3 What flips the winner

Each line changes one thing and runs the rule again.

| Change | Winner | Top three | Same winner? |
|---|---|---|---|
| judge 1 alone, before the referee | ISR | ISR, SPLIT, DRAFT | **no** |
| judge 2 alone, before the referee | ISR | ISR, DRAFT, SLOG | **no** |
| every open SHOULD counted as met | level: DRAFT, SPLIT, ISR | DRAFT, SPLIT, ISR | yes |
| every open SHOULD counted as not met | level: DRAFT, SPLIT, ISR | DRAFT, SPLIT, ISR | yes |
| rule 3 the other way: SHOULDs first, then novel mechanisms | level: DRAFT, SPLIT, ISR | DRAFT, SPLIT, ISR | yes |
| novel mechanisms as counter a counted them | level: DRAFT, SPLIT, ISR | DRAFT, SPLIT, ISR | yes |
| novel mechanisms as counter b counted them | level: DRAFT, SPLIT, ISR | DRAFT, SPLIT, ISR | yes |
| the user chooses the other way on: F_w | level: DRAFT, SPLIT, ISR | DRAFT, SPLIT, ISR | yes |
| the user chooses the other way on: N_res | level: DRAFT, SPLIT, ISR | DRAFT, SPLIT, ISR | yes |
| the user chooses the other way on: PERF-01 losses | level: DRAFT, SRV, SPLIT, ISR, SLOG, RLOG, EMB-V8 | DRAFT, SRV, SPLIT | **no** |
| the user chooses the other way on: region scope | level: DRAFT, SPLIT, ISR | DRAFT, SPLIT, ISR | yes |
| the user chooses the other way on: shared tier | ISR | ISR, DRAFT, SPLIT | **no** |
| the user chooses the other way on: fsync figure | level: DRAFT, SPLIT, ISR | DRAFT, SPLIT, ISR | yes |
| the user chooses the other way on: DATA-01 reading | level: DRAFT, SPLIT, ISR | DRAFT, SPLIT, ISR | yes |
| the user chooses the other way on: other | level: DRAFT, SPLIT, ISR | DRAFT, SPLIT, ISR | yes |
| the user reads DEV-01 the other way (one of "other") | level: DRAFT, SPLIT, ISR | DRAFT, SPLIT, ISR | yes |
| the user reads F-07 the other way (one of "other") | level: DRAFT, SPLIT, ISR | DRAFT, SPLIT, ISR | yes |
| the user reads P-02 the other way (one of "other") | level: DRAFT, SPLIT, ISR | DRAFT, SPLIT, ISR | yes |
| the user reads P-13 the other way (one of "other") | level: DRAFT, SPLIT, ISR | DRAFT, SPLIT, ISR | yes |
| the user reads PERF-08 the other way (one of "other") | level: DRAFT, SPLIT, ISR | DRAFT, SPLIT, ISR | yes |
| one SHOULD left out, each in turn | level: DRAFT, SPLIT, ISR | | 16 of 16 keep the winner |
| one row given 2 more or 2 fewer novel mechanisms, each row in turn | level: DRAFT, SPLIT, ISR | | 40 of 40 keep the winner |

## B. With the clauses of AMENDMENTS 1.3 restated as the evidence asks

### B.1 Each row

| Row | MUSTs failed by design | MUSTs open | MUSTs met | Novel mechanisms (DEV-01) | SHOULDs met | SHOULDs not met | SHOULDs open | Interacting pairs (DEV-02) |
|---|---|---|---|---|---|---|---|---|
| DRAFT | none | 100 | 32 | 5 | 5 | 3 | 8 | 309 |
| MIN | PERF-04 | 96 | 35 | 4 | 5 | 4 | 7 | 253 |
| RUST | PERF-04 | 97 | 34 | 4 | 5 | 4 | 7 | 253 |
| SRV | PERF-04 | 102 | 29 | 4 | 5 | 4 | 7 | 267 |
| LEAN | PERF-04 | 96 | 35 | 4 | 5 | 4 | 7 | 255 |
| CELL | OPS-01, P-07, SC-03, SC-08, SC-10 | 100 | 27 | 4 | 5 | 3 | 8 | 277 |
| LANE | PERF-04, SC-03, SC-04, SC-10 | 95 | 33 | 3 | 5 | 3 | 8 | 232 |
| SPLIT | none | 102 | 30 | 4 | 5 | 3 | 8 | 295 |
| PD | F-22, PERF-04, SC-05 | 117 | 12 | 0 | 4 | 3 | 9 | 218 |
| ISR | SC-03, SC-04, SC-10 | 117 | 12 | 2 | 1 | 2 | 13 | 214 |
| SLOG | PERF-04 | 117 | 14 | 5 | 2 | 4 | 10 | 272 |
| OBJ | DEP-21, F-15, P-01, P-05, PERF-04, PERF-07, PERF-08 | 111 | 14 | 2 | 1 | 3 | 12 | 144 |
| V4 | DATA-01, DATA-07, DEP-02, DEP-05, DEP-12, DEP-18, F-01, F-02, F-03, F-04, F-07, F-08, F-09, F-14, F-21, OPS-01, OPS-03, OPS-05, OPS-06, P-01, P-02, P-05, P-06, P-07, P-08, P-09, P-10, P-11, P-13, P-14, P-15, P-16, P-17, P-20, P-22, PERF-02, PERF-03, PERF-04, PERF-05, PERF-06, PERF-07, PERF-10, PERF-11, PERF-13, SC-03, SC-05, SC-08, SC-10, SC-13, TEST-13 | 64 | 18 | 8 | 2 | 9 | 5 | 52 |
| MIN-P | PERF-04 | 96 | 35 | 3 | 5 | 4 | 7 | 252 |
| MIN-TS | PERF-04 | 94 | 37 | 4 | 5 | 4 | 7 | 253 |
| RLOG | PERF-04 | 96 | 35 | 4 | 5 | 3 | 8 | 268 |
| EMB-V8 | PERF-04 | 99 | 32 | 4 | 5 | 4 | 7 | 269 |
| SIDE | PERF-04 | 99 | 32 | 4 | 5 | 4 | 7 | 277 |
| BUY | DEP-12, DEP-20, DEV-07, F-02, F-05, F-19, OPS-11, P-06, P-10, P-11, P-14, PERF-02, PERF-03, PERF-04, PERF-05, PERF-06, PERF-07, PERF-10, SC-01, SC-03, SC-05, SC-07, SC-10, TEST-01, TEST-09, TEST-10, TEST-13 | 96 | 9 | 0 | 2 | 7 | 7 | 12 |
| COMP | none | 100 | 32 | 3 | 5 | 4 | 7 | 283 |

### B.2 The ranking

Rows still in (no MUST failed by design): DRAFT, SPLIT, COMP.

Rule 3 is applied to every pair of rows still in. **COMP beats every other row.**

| Place | Row | Pairs won | Pairs lost | Novel mechanisms | SHOULDs met | Interacting pairs |
|---|---|---|---|---|---|---|
| 1 | COMP | 2 | 0 | 3 | 5 | 283 |
| 2 | SPLIT | 1 | 1 | 4 | 5 | 295 |
| 3 | DRAFT | 0 | 2 | 5 | 5 | 309 |

### B.3 What flips the winner

Each line changes one thing and runs the rule again.

| Change | Winner | Top three | Same winner? |
|---|---|---|---|
| judge 1 alone, before the referee | COMP | COMP, SPLIT, DRAFT | yes |
| judge 2 alone, before the referee | COMP | COMP, DRAFT | yes |
| every open SHOULD counted as met | SPLIT | SPLIT, COMP, DRAFT | **no** |
| every open SHOULD counted as not met | COMP | COMP, SPLIT, DRAFT | yes |
| rule 3 the other way: SHOULDs first, then novel mechanisms | COMP | COMP, SPLIT, DRAFT | yes |
| novel mechanisms as counter a counted them | COMP | COMP, SPLIT, DRAFT | yes |
| novel mechanisms as counter b counted them | COMP | COMP, SPLIT, DRAFT | yes |
| the user chooses the other way on: F_w | COMP | COMP, SPLIT, DRAFT | yes |
| the user chooses the other way on: N_res | COMP | COMP, SPLIT, DRAFT | yes |
| the user chooses the other way on: PERF-01 losses | MIN-P | MIN-P, MIN, RUST | **no** |
| the user chooses the other way on: region scope | COMP | COMP, SPLIT, DRAFT | yes |
| the user chooses the other way on: shared tier | COMP | COMP | yes |
| the user chooses the other way on: fsync figure | COMP | COMP, SPLIT, DRAFT | yes |
| the user chooses the other way on: DATA-01 reading | COMP | COMP, SPLIT, DRAFT | yes |
| the user chooses the other way on: other | level: DRAFT, SPLIT, COMP | DRAFT, SPLIT, COMP | **no** |
| the user reads DEV-01 the other way (one of "other") | COMP | COMP, SPLIT, DRAFT | yes |
| the user reads F-07 the other way (one of "other") | level: DRAFT, SPLIT, COMP | DRAFT, SPLIT, COMP | **no** |
| the user reads P-02 the other way (one of "other") | level: DRAFT, SPLIT, COMP | DRAFT, SPLIT, COMP | **no** |
| the user reads P-13 the other way (one of "other") | level: DRAFT, SPLIT, COMP | DRAFT, SPLIT, COMP | **no** |
| the user reads PERF-08 the other way (one of "other") | COMP | COMP, SPLIT, DRAFT | yes |
| one SHOULD left out, each in turn | COMP | | 16 of 16 keep the winner |
| one row given 2 more or 2 fewer novel mechanisms, each row in turn | COMP | | 40 of 40 keep the winner |

### B.4 Rows that one or two MUSTs put out

| Row | Out on | If those were waived it would place | Winner then |
|---|---|---|---|
| MIN | PERF-04 | 1 | MIN |
| RUST | PERF-04 | 1 | RUST |
| SRV | PERF-04 | 1 | SRV |
| LEAN | PERF-04 | 1 | LEAN |
| SLOG | PERF-04 | 4 | COMP |
| MIN-P | PERF-04 | 1 | MIN-P |
| MIN-TS | PERF-04 | 1 | MIN-TS |
| RLOG | PERF-04 | 1 | RLOG |
| EMB-V8 | PERF-04 | 1 | EMB-V8 |
| SIDE | PERF-04 | 1 | SIDE |
