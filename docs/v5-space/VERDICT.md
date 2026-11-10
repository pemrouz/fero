# The v5 verdict

Written 2026-11-10 for the v5 design-space study ([BRIEF.md](BRIEF.md)), and revised the same day after three skeptics and a price check (section 10). This page reads the arithmetic in [judging/OUTCOME.md](judging/OUTCOME.md), which `python3 tools/judging.py verdict` built from the settled judging files, and the files behind it. Where it states a number that OUTCOME.md does not print, it says how the number was got. Numbers marked "computed here" come from scratch scripts that call `tools/judging.py`'s own `tally`, `rank` and pair rule on copies of the judging files; nothing in the judging files was changed (section 10 names the scripts).

## 0. The answer

1. **COMP2**: Raft groups owned by the project, each holding fixed slots of many resources; one loop on `#meta`'s leader heals replicas and proposes slot moves; a write commits `persisted` by default, or `memory` or `none` per resource; a damaged log entry is repaired from a peer. TypeScript first, a native core later.
2. COMP2 is COMP, the study's composite, with its two undecided axes set the way rule 3 picks them: C `cent-co` and Z `par`. No judge scored COMP2 as a row, but every one of its cells was scored: COMP and MIN-P got the same verdict on every cell but PERF-04 (NATS JetStream), which COMP2 shares with COMP, and `par` meets F-22 (One bad entry, S) by [E-37]'s model.
3. With the 1.3 clauses restated (outcome B), the judged winner is COMP, and rule 3 ranks COMP2 above it: 3 novel mechanisms each, 6 SHOULDs met against 5, 274 interacting pairs against 283 (computed here). As worded (outcome A), every row fails a MUST, and ISR leads only because less of it was tested.
4. **How sure: not final.** The judges agreed on 88.9 % of cells, and COMP2 holds under either judge, both counters and every SHOULD reading. But its edge rests on one SHOULD and 19 pairs from a reads-and-writes list no second agent checked, and rule 3 never counts open MUSTs: two rows nobody judged rank above it on copied cells (a split-and-merge version, 266 pairs; TiKV's shape with fixes, 0 novel mechanisms and 119 MUSTs open).
5. **Choice 1:** accept JetStream's default row as a loss by name (PERF-01, Fair comparison), and the `memory` rung goes: MIN-P with `par` wins.
6. **Choice 2:** may a row with more untested MUSTs outrank a better-tested one on counts alone? As written, yes, and the rows of line 4 come first. Also: four clause groups of AMENDMENTS 1.3 (P-05 fan-out by room; SC-03 and SC-10 scale writes up; F-05 failover time; F-17 partial partitions) must be restated or no row is in; F-05 alone kept puts SLOG first, F-15 (outside services) kept puts SPLIT first, and F-07 (restart in any order), P-02 (cache with expiry) or P-13 (presence) read to the letter puts every row out (sections 4 and 8).
7. **Next step:** one judging pass over COMP2 and the two unjudged rivals, with the re-rulings of section 10; the three models COMP2 rests on (its controller healing while it moves slots, the `memory` rung inside Raft, `par` with a voter change); then COMP2's thin TypeScript slice, under chaos, timed with each rival's own tool.
8. **First kill test:** `nats bench js` with one write in flight: the `memory` rung's p99 must beat JetStream's 0.55 ms by more than the larger spread, so it must come in below about 0.30 ms ([E-09b]).

## 1. The question and the rule

**What was compared.** 20 judged rows. A **row** is one whole design: one option on each of 22 axes ([SPACE.md](SPACE.md) section 2). Nineteen are SPACE's named designs as AMENDMENTS sections 1 and 3 fixed them; the twentieth, **COMP**, takes the option AMENDMENTS section 2 favours on each axis (AMENDMENTS section 4). They were judged against the 140 requirements of [REQUIREMENTS.md](REQUIREMENTS.md): 148 parts, 132 of them MUST and 16 SHOULD. A **cell** is one requirement part for one row: 148 × 20 = 2,960 cells.

**Words used below.**
- A MUST is **met**, **open** (not shown either way) or **fails**. A SHOULD is met, not met, or open.
- A **mechanism** is one named piece of durable or replicated state plus the rules that write it. It is **novel** when no paper or production system has the same state and rules in the same role (DEV-10, Counting convention). DEV-01 (Few novel mechanisms) counts them per row.
- An **interacting pair** is two mechanisms of one row that touch one piece of state, at least one writing it. DEV-02 (Few interactions) counts them. The counts come from code ([judging/pairs.json](judging/pairs.json)); [MECHANISMS.md](MECHANISMS.md) section 2 still prints the counts from before E-32's four read-set fixes for PD (210), ISR (215) and OBJ (147), which pairs.json gives as 209, 214 and 144 ([pairs.md] section 2). This page uses pairs.json.
- **C** is the study's commit bar: the fsync p99 with three writers plus the round-trip p99. On this box C = 0.73 ms ([E-01], measured). It is a sum of two p99s, not a floor: a commit at two of three can be faster (section 3).
- A **rung** is what a commit means: `persisted` (on disk at a majority), `memory` (in memory at a majority), `none` (best effort).
- A **group** is one Raft log with one leader. A **slot** is a fixed share of a resource's keys; a slot move takes a slot from one group to another.
- **A-nn** is a fix of AMENDMENTS section 1; **K-nn** a crossing of AMENDMENTS section 4 (mechanisms that no experiment ran together); **G-nn** a gap of AMENDMENTS section 5.

**The judging rule** (REQUIREMENTS, "Judging rule"), in plain words:
1. A row **fails** a MUST only on proof: a counterexample in a model of its own mechanism, a measured ceiling below the bar, or a structural argument that a second agent confirms in writing. Otherwise the MUST is **open**.
2. A row that fails a MUST is **out**. If every row is out, rank them by how many MUSTs each fails, then by the sum of gap ÷ bar over those MUSTs.
3. Among the rows still in: if two rows' counts of novel mechanisms differ by 2 or more, the lower count wins. Otherwise the row that meets more SHOULDs wins. If still level, fewer interacting pairs wins.
4. (For the user to confirm.) Rule 3 ranks few novel mechanisms above the SHOULD count.

**What the rule does not look at.** Rules 2 and 3 never count open MUSTs, and never count rules. So a row with less evidence can rank above a row with more, in both outcomes (sections 2 and 4).

**Why two outcomes.** AMENDMENTS section 1.3 lists clauses that the evidence shows no row meets as worded, and what each experiment asks instead. The wording is the user's, so 189 cells carry two verdicts. **Outcome A** uses the requirements as written. **Outcome B** uses the clauses restated as section 1.3 asks.

**How the cells were judged.** The requirements were split into seven groups. Two judges scored each group without seeing each other's work. A referee ruled in writing on every one of the 330 cells where they differed (73 of them decisive), and never against both. Code did the arithmetic. Two counters, also blind, counted the mechanisms, and a referee settled their differences ([MECHANISMS.md](MECHANISMS.md)). The pairs come from code and were placed by E-32 ([pairs.md]).

**Rows beyond the 20.** AMENDMENTS section 4 asked the judges to score COMP+par beside COMP; no judging file holds it. So this page prices, with the study's own code, the rows one or two axes from COMP that the skeptics raised. A row's cells are copied from judged rows; its mechanisms are a judged row's, plus or minus whole units of [judging/mechanisms.json](judging/mechanisms.json); its pairs use the tool's pair rule (computed here).

| Row | What it is | Where its cells come from |
|---|---|---|
| **COMP2** | COMP with C `cent-co` (one loop on `#meta`'s leader heals and moves, as in MIN-P) and Z `par`; equally, MIN-P with the `memory` rung and `par` | COMP's cells, which equal MIN-P's on every cell but PERF-04 (a cell of the rung COMP2 keeps), with F-22 (S) met by [E-37] (`par2d`: 276 two-damage states, 0 stuck), as both judges' own text for COMP's F-22 (S) says. No new judgement |
| COMP+par | COMP with Z `par` (AMENDMENTS section 4's add-on) | the same as COMP2 |
| MIN-P+m | COMP with C `cent-co`; equally, MIN-P with the `memory` rung | COMP's cells |
| MIN-P+par | MIN-P with Z `par`, no `memory` rung | MIN-P's cells, with F-22 (S) met |
| SPLIT2 | SPLIT made like COMP2: client sessions, no log replicas, the controller heals, its merge counted, `par` | SPLIT's cells, with F-22 (S) met; where SPLIT and COMP differ (DEP-15 S, P-17, TEST-12), each cell follows the axis that decides it (COMP's DEP-15 S, SPLIT's P-17 and TEST-12): three cells assigned by reasoning |
| PD+fix | PD (TiKV's shape) with the disk incarnation (Z `rejoin`), the object-store tier and the `memory` rung | PD's cells, with COMP's F-22 (M), PERF-04 and SC-05: three cells assigned by reasoning, and PD's own cells for the other 145 |

**How this page picks the answer.** It names the best row by rule 3 among rows whose every cell a judge has already scored. COMP2 is that row. SPLIT2 and PD+fix need cells assigned by reasoning, so they go to the next judging pass; their standing is given in sections 4 and 6.

**The user's numbers in force.** Until the user answers, the proposed values of REQUIREMENTS apply: F_w = 64 writers per resource; N_res = 100,000 resources per project; no competitor-default loss accepted; one region per group; a tier shared between projects allowed (J changes); every latency bar also stated against a cited fsync figure; rule 3 in the order written.

## 2. Outcome A: the requirements as worded

**The result.** Every row fails at least one MUST, so rule 2 ranks them. ISR is first ([OUTCOME.md](judging/OUTCOME.md) A.2).

The MUSTs named in the table: P-05 WebSocket fan-out by room; SC-03 Scale writes up; SC-04 Scale down; SC-10 Only stated ceilings, each above its floor; F-15 Outside services; PERF-04 NATS JetStream; F-05 Failover time; F-17 Partial partitions.

| Place | Row | MUSTs failed | Gap ÷ bar, summed | MUSTs open | MUSTs met |
|---|---|---|---|---|---|
| 1 | ISR | P-05, SC-03, SC-04, SC-10 | 1.77 | 116 | 12 |
| 2 | SLOG | F-15, P-05, PERF-04, SC-03, SC-10 | 2.10 | 113 | 14 |
| 3 | DRAFT | F-05, F-17, P-05, SC-03, SC-10 | 3.21 | 93 | 34 |
| 3 | SPLIT | F-05, F-17, P-05, SC-03, SC-10 | 3.21 | 95 | 32 |
| 5 | COMP | F-05, F-15, F-17, P-05, SC-03, SC-10 | 3.21 | 92 | 34 |

The other 15 rows place 6th to 20th (OUTCOME A.2; section 6). COMP2, COMP+par and MIN-P+m have COMP's cells as worded, so they sit with COMP in 5th place (computed here). If the F-02 re-ruling of section 10 is taken, DRAFT's met count is 33 and SPLIT's 31.

**What it means.**
- **Rule 2 counts only failures that are proven.** A MUST that nobody tested stays open and costs nothing. So a row with less evidence can rank above a row with more. ISR leads because its F-05 and F-17 were never run, not because they hold: no ISR failover was timed, and E-38 did not run ISR ([ISR scorecard](judging/rows/ISR.md)). The same is true of SLOG. The Raft rows fail those two because etcd's own Raft was measured and simulated.
- **SC-04 is failed by ISR and LANE only.** ISR's partition count is fixed when a resource is made, and nothing merges a group (structural). ISR's other three failures are failed by every row as worded. ISR still fails SC-03, SC-04 and SC-10 in outcome B.
- **Most gaps come from ceilings.** A failure proven by a counterexample carries no gap number, and neither do most structural ones; ten structural failures do carry one: V4's PERF-02, PERF-03, PERF-04, PERF-05, PERF-06, PERF-07, PERF-11 and DEP-12 (0.91 to 0.999) and BUY's SC-03 and SC-10 (0.98 each). They are inside V4's 10.04 and BUY's 9.24, and no place changes because of them (rule 2 orders by count first).
- **Two shared failures are not proven well enough.** F-05's handover clause (the 15 Raft rows) is failed on etcd's own pause, which is not a ceiling for a port, and P-05 (every row) on one prototype's working point, not a floor (section 10, "Cells to re-rule"). With both re-ruled open as worded, first place is level: DRAFT, SPLIT and ISR, each with 3 MUSTs and a gap sum of 1.32. With F-17 read the clique way as well (section 8, item 23), DRAFT and SPLIT lead with 2 (computed here).

**Every gap ÷ bar in the settled cells** (rule 2 asks this page to write each one down; "restated" is the verdict in outcome B):

| Requirement | Gap ÷ bar | Proof | Restated | Rows |
|---|---|---|---|---|
| P-05 | 0.45 | ceiling | met | DRAFT, MIN, RUST, SRV, LEAN, LANE, SPLIT, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| P-05 | 0.45 | ceiling | open | CELL, PD, ISR, SLOG, BUY |
| P-05 | 0.91 / 2.2 | ceiling | fails | V4 / OBJ |
| SC-03 and SC-10 | 0.66 | ceiling | open | DRAFT, MIN, RUST, SRV, LEAN, SPLIT, PD, SLOG, OBJ, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| SC-03 and SC-10 | 0.66 | ceiling | fails | LANE, ISR, V4 |
| SC-03 and SC-10 | 0.77 | ceiling | fails | CELL |
| SC-03 and SC-10 | 0.98 | structural | fails | BUY |
| F-05 | 1.44 | ceiling | open | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, PD, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| F-05 | 1.08 | ceiling | fails | BUY |
| PERF-04 | 0.33 | ceiling | fails | MIN, RUST, SRV, LEAN, LANE, PD, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE |
| PERF-04 | 0.43 / 0.93 | ceiling / structural | fails | OBJ / V4 |
| PERF-02, PERF-05, PERF-06, PERF-07 | 0.96, 0.96, 0.98, 0.84 | ceiling | fails | BUY |
| PERF-02, PERF-03, PERF-05, PERF-06, PERF-07, PERF-11 | 0.997, 0.996, 0.997, 0.999, 0.99, 0.91 | structural | fails | V4 |
| PERF-07, PERF-08 | 0.38, 1.17 | ceiling | fails | OBJ |
| DEP-12 | 0.93 / 0.995 | ceiling / structural | fails | BUY / V4 |
| F-19 | 1.08 | ceiling | fails | BUY |
| DEP-21 | 12.58 | ceiling | fails | OBJ |

**The clauses rows fail as worded** (AMENDMENTS 1.3; cells in the `settled.json` files):

| Clause | Rows that fail it as worded | Why | What the evidence asks |
|---|---|---|---|
| P-05 (WebSocket fan-out by room): delivery p99 ≤ C + one hop | all 20 | C + one hop is about 0.83 ms here. E-08's relay alone had p99 1.2 ms (Node) and 3.5 ms (Rust) at 1,000 subscribers with no added wait, at a load where each relay used about half a core, and 0.22 to 0.25 s at 10,000 on one core ([E-08], measured). That is one prototype's working point, not a floor (section 10) | a coalescing window per room and about 1,000 sockets a core |
| SC-03 (Scale writes up) and SC-10: at least F_w = 64 effective writers per resource | all 20 | under Zipf 0.99 the hottest partition holds 5.5 to 9.8 % of the load and nothing splits a partition, so every design reaches only 12 to 22 effective writers ([E-18], simulated) | "with every partition above half a writer's share split by the app": then 72 at 1,024 slots, 135 at 4,096 |
| F-05's handover clause: a planned handover pauses writes ≤ 10 ms (TS) / 2 ms (native) | the 15 Raft rows | etcd's own handover pauses its group 9.7 to 9.8 ms at the median and 24 to 31 ms at worst on this disk ([E-13], measured). E-13 itself reads this as met at the median and not at the tail; the quiet window's own longest gap ran 4.4 to 22.9 ms, so the tail is mostly the disk; and AMENDMENTS 1.3 says the clause is restated "or it stays open" (section 10 asks to re-rule it open) | "C plus the box's normal longest gap between commits plus 5 ms" |
| F-17 (Partial partitions) | the 15 Raft rows | 5 of 280 five-node partial partitions stayed stuck with a connected majority, by Raft's own vote rule ([E-38], simulated on etcd's Raft; ISR, SLOG, OBJ and V4 not run). E-38 reads "connected majority" as a star: one server with two-way links to a majority. None of the 5 stuck runs has a majority in which every pair talks both ways (a clique): read that way, 0 of 299 five-node and 0 of 159 three-node runs got stuck (computed here from E-38's `sweep5` and `sweep3` results) | "a connected majority that includes an up-to-date replica", or a new election rule (+1 novel mechanism); or the clique reading (section 8, item 23) |
| F-15 (Outside services) | the 8 slot rows whose restore mark lives in the object store: MIN, RUST, LEAN, SLOG, MIN-P, MIN-TS, SIDE, COMP (and COMP2) | a slot move records its new epoch in the store before use ([E-33]'s rule), so a move waits while the store is down; F-15 lets only wake, new replicas and old history wait (structural) | F-15's list adds slot moves, or the mark gets another home |

F-15 is not failed by every row: it is a clash between the store-held restore mark and F-15's list. DRAFT, SRV, RLOG and EMB-V8 move slots too, but they found a cluster by `fero init`, and A-08 leaves the home of their mark open, so their F-15 is open. [MECHANISMS.md](MECHANISMS.md) names the unit "Restore mark in the store's manifest" for them as well; if their mark lives there, they fail F-15 as COMP does, and so does SPLIT if a split must record its new epoch before use (reasoned; section 8, item 11). The other lines of 1.3 leave the leading rows' cells open either way: SC-08 (Without worry) part (b), SC-13 (Many resources) and its "small", SC-05 (Scale to zero and back) at 10 GB, F-10 (Disks) and its untested clauses, and DEP-21 (Cost is a number) and its $10.

So, as worded, the order mostly shows how much of each row was tested (reasoned here).

## 3. Outcome B: the clauses restated

**The judged rows.** Rows still in (no MUST failed): DRAFT, SPLIT, COMP. Rule 3 between them ([OUTCOME.md](judging/OUTCOME.md) B.2):

| Pair | Novel mechanisms | SHOULDs met | Interacting pairs | What decides | Winner |
|---|---|---|---|---|---|
| COMP against SPLIT | 3 against 5 | 5 against 5 | 283 against 278 (295 with SPLIT's merge) | the counts are 2 apart | COMP |
| COMP against DRAFT | 3 against 6 | 5 against 5 | 283 against 309 | 3 apart | COMP |
| SPLIT against DRAFT | 5 against 6 | 5 against 5 | 278 (295) against 309 | 1 apart, SHOULDs level, fewer pairs | SPLIT |

The three meet the same five SHOULDs: DEV-04 (Published core), DEV-05 (Small code), OPS-11 (Debugging in production), P-22 (Delayed jobs, waiting takes, priorities) and SC-12 (Clients).

**SPLIT's merge.** The referee kept SPLIT's SC-04 (Scale down) open only because "the row shrinks through the merge", and wrote that if SPLIT keeps the merge, DEV-01 counts it for SPLIT ([judging/SC.settled.json](judging/SC.settled.json)). SPACE section 2 defines P `split` as splitting "and later merges", and AMENDMENTS section 3 charges SPLIT both protocols (37 rules). But [judging/mechanisms.json](judging/mechanisms.json) gives `merge-record` to PD only, so SPLIT's 278 pairs leave the merge out. With it, SPLIT has 295 pairs (the merge is not novel, so its count stays 5). Without it, SC-04 fails and SPLIT is out. Under either reading, COMP stays ahead of SPLIT if the novel-count gap moves by up to 3 either way, and SPLIT wins only at 4 (computed here). OUTCOME B.3's two lines "SPLIT with −2" and "COMP with +2" give SPLIT only because they use the 278 that leaves the merge out.

**COMP's neighbours.** Rule 3 over the judged rows and the rows of section 1 whose cells are all judged (computed here):

| Pair | Novel mechanisms | SHOULDs met | Interacting pairs | What decides | Winner |
|---|---|---|---|---|---|
| COMP2 against COMP | 3 against 3 | 6 against 5 | 274 against 283 | F-22 (S), one more SHOULD | COMP2 |
| COMP2 against COMP+par | 3 against 3 | 6 against 6 | 274 against 293 | fewer pairs | COMP2 |
| COMP2 against MIN-P+m | 3 against 3 | 6 against 5 | 274 against 264 | F-22 (S) | COMP2 |
| COMP2 against SPLIT | 3 against 5 | 6 against 5 | 274 against 278 (295) | the counts are 2 apart | COMP2 |
| COMP2 against DRAFT | 3 against 6 | 6 against 5 | 274 against 309 | 3 apart | COMP2 |
| MIN-P+m against COMP | 3 against 3 | 5 against 5 | 264 against 283 | fewer pairs | MIN-P+m |

**COMP2 wins outcome B among these rows.** Two things lift it over COMP:
- **Z `par`.** MECHANISMS section 4.2 settles `par-repair` as not novel (the precedent is PAR, Alagappan et al., FAST'18, built into LogCabin). So `par` adds no novel mechanism and meets one more SHOULD: two replicas, each with one bad entry, stay writable ([E-37], model-checked: 276 of 276 two-damage states reach a working leader). COMP's own F-22 (S) cell says it is not met "only" because no row holds `par`.
- **C `cent-co`.** The judges gave COMP (leaders heal) and MIN-P (a controller loop heals) the same verdict on every cell but PERF-04, which is a cell of the `memory` rung, not of healing. So leader healing earns COMP no cell. The counts tie (3 each), and by the tool's pair rule the controller form has fewer pairs: COMP's leader healing, planner hints and its own slow-leader rule make 49 distinct pairs, the controller's commands and its slow-leader rule 30. AMENDMENTS section 2 C expected the controller to cost one more pair; in the composed row it costs 19 fewer (computed here). AMENDMENTS chose `self` on E-16's rule count (14 against 18), which rule 3 does not use.

**Rows out in B.** Ten rows fail only PERF-04 (NATS JetStream): MIN, RUST, SRV, LEAN, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE. Their only durable rung is `persisted`. JetStream at its default acks one publisher at p99 0.550 ms, and its three runs spread from 0.536 to 0.783 ms ([E-09b], measured). PERF-01 counts a win only when fero's median beats it by more than the larger spread, so fero needs a p99 below about 0.30 ms. A `persisted` commit at two of three plus the client's hop is about 0.42 ms even in the best case, with independent disks (computed here by sampling [E-01]'s measured one-writer fsync distribution, p99 481 µs, with one-way hops of half its 58 µs round trip: 0.36 ms at p99 for the commit, plus 58 µs for the client; a reasoned model of measured parts). So the failure stands. The cells give a different reason, "C = 0.73 ms is the floor of any persisted commit", and C is a sum of two p99s, not a floor (section 10 asks to restate it; the verdict and the order do not change). Let back in alone, each of the ten would win among the judged rows except SLOG (OUTCOME B.4); against COMP2 each loses on F-22 (S) and places 3rd or lower (computed here). The other rows fail MUSTs of their own (section 6).

## 4. How sure

**The judges' agreement** ([OUTCOME.md](judging/OUTCOME.md) section 1):

| Group | Cells | Same verdict | Decisive differences | Minor differences | Referee against both |
|---|---|---|---|---|---|
| P | 500 | 409 (81.8%) | 20 | 71 | 0 |
| PERF-DATA | 460 | 371 (80.7%) | 15 | 74 | 0 |
| SC | 300 | 265 (88.3%) | 22 | 13 | 0 |
| F | 460 | 432 (93.9%) | 7 | 21 | 0 |
| DEV | 220 | 220 (100.0%) | 0 | 0 | 0 |
| DEP | 460 | 417 (90.7%) | 5 | 38 | 0 |
| TEST-OPS | 560 | 516 (92.1%) | 4 | 40 | 0 |
| **All** | 2,960 | 2,630 (88.9%) | 73 | 257 | 0 |

A decisive difference is one that could change the ranking. The mechanism counters agreed on 94 of 103 units (MECHANISMS section 1). But the leading rows barely differ on cells: COMP differs from MIN-P on 1 cell (PERF-04), from DRAFT on 1 (DEP-15 S) and from SPLIT on 3 (DEP-15 S, P-17, TEST-12) in outcome B (computed here). So the order at the top is set by the mechanism catalogue and the pair counts, not by the judges. The two counters judged novelty and rows; the reads and writes that make the pairs were written once in [judging/mechanism-list.json](judging/mechanism-list.json), and E-32 (a) checked only the most-carried pairs and the pairs between novel mechanisms ([pairs.md] section 2).

**Every line of OUTCOME's "what flips the winner" that changes it** (the 20 judged rows):

| Outcome | The change | Winner then | Why |
|---|---|---|---|
| A | the user accepts PERF-01 (Fair comparison) losses | level: ISR, SLOG | SLOG's PERF-04 failure goes (gap 0.33). SLOG then fails 4 MUSTs with a gap sum of 1.77, the same as ISR's, and rule 2 has no further tie-break |
| B | the user accepts PERF-01 losses | MIN-P | PERF-04 turns open for the 12 rows with only `persisted`, and ten of them come back in. MIN-P has COMP's 3 novel mechanisms, the same 5 SHOULDs and fewer pairs (252 against 283) |
| B | "other" readings, and each of F-07 (Restart in any order), P-02 (Cache with expiry, session store) and P-13 (Presence) read the other way | level: DRAFT, SPLIT, COMP | each reading turns a cell into a failure for every one-writer row (F-07: the two-voter window counted as a counterexample; P-02: 2,036 ms late against 350 ms after a failover near the ttl; P-13: 12.4 s after a `#sessions` failover near the lapse). Every row is then out; the three fail one MUST each with no gap, and rule 2 has no tie-break |
| B | SPLIT with 2 fewer novel mechanisms, or COMP with 2 more | SPLIT | 3 against 3 (or 5 against 5): SHOULDs level, and SPLIT has fewer pairs (278 against 283). With the merge counted (295), COMP keeps it (section 3) |

**The same sweep with COMP's neighbours added** (computed here). COMP2 keeps the win under judge 1 alone, judge 2 alone, every open SHOULD counted as met or as not met, rule 3 with SHOULDs first, both counters' own counts (COMP2 3 and 3; COMP 3 and 5), the other way on F_w, N_res, region scope, the shared tier and the fsync figure, and the DEV-01 and PERF-08 readings; with SPLIT's merge counted or not; and if log replicas, or log replicas and the dedup window, are judged not novel. It flips in these lines:

| The change | Winner then | Why |
|---|---|---|
| the user accepts PERF-01 losses | MIN-P+par | without the bar, the `memory` rung buys nothing; MIN-P+par has 3 novel mechanisms, 6 SHOULDs and 261 pairs against COMP2's 274 |
| any "other" reading (F-07, P-02, P-13) | level: DRAFT, SPLIT, COMP, MIN-P+m, COMP+par, COMP2 | as above: every row is out with one MUST failed and no gap |
| F-22 (S) left out | MIN-P+m | `par`'s only gain goes, and MIN-P+m has fewer pairs (264 against 274) |
| COMP2 alone given 2 more novel mechanisms | COMP+par | 5 against 3. Two novel mechanisms that only the controller form needs (for example, found by K-07's controller-form model) would do this; one in the `memory` rung or the slot move would hit both rows alike |
| 19 or more pairs moved between the two control planes by a second check of the reads and writes | COMP+par | the C axis is decided by 274 against 293 |

**Changes the sweeps do not print** (computed here, or reasoned from the cells where marked):

| The change | Winner then | Why |
|---|---|---|
| F-15 kept as worded, the rest restated | SPLIT | COMP and COMP2 fail F-15 (structural); DRAFT and SPLIT keep it open, and SPLIT beats DRAFT on pairs. This holds only while DRAFT's and SPLIT's restore mark has no home |
| the same, with DRAFT's mark in the store too | SPLIT | SPLIT is the only row in, if a split needs no mark write before use |
| the same, with a split also writing the mark before use | level: DRAFT, SPLIT, COMP, COMP2 and the other neighbours | every row is out with one MUST failed and no gap. "The mark gets another home" is open to COMP2 as much as to the others (reasoned) |
| F-15 kept as worded, and SPLIT without its merge | DRAFT | SPLIT fails SC-04 |
| F-15 kept as worded and PERF-01 losses accepted | SRV on the cells as they stand; SPLIT if the `fero init` rows' mark lives in the store; level if a split writes it too | with the loss accepted, SRV, RLOG and EMB-V8 come back, and they keep F-15 open only while their mark has no home |
| F-05 kept as worded, the rest restated | SLOG, by rule 2, on the cells as they stand | every Raft row fails F-05 (gap 1.44); SLOG fails only PERF-04 (0.33), and its own F-05 was never timed. If F-05 is re-ruled open as worded (section 10), this line goes |
| P-05, SC-03, SC-10 or F-17 kept as worded, the rest restated | level among every row in | they all fail the same one clause with the same gap |
| F_w set above 135 (reasoned from the cells) | SPLIT, the only judged row in | the restated SC-03 cells of DRAFT and COMP (and so COMP2) say "above 135 the restated verdict fails too"; SPLIT's key-level splits have no fixed ceiling |
| log replicas judged not novel (TiKV's witness, section 10) | SPLIT among the judged rows with SPLIT's 278 pairs; COMP with the merge counted (295); COMP2 with the neighbours | SPLIT has 4: one apart from COMP |

**Rows nobody judged that rank above COMP2 on copied cells** (computed here; cells as section 1 says):

| Row | Novel | SHOULDs met | Pairs | MUSTs open | MUSTs met | Against COMP2 | Why it is not named |
|---|---|---|---|---|---|---|---|
| SPLIT2 | 3 (dormant groups, the restore mark, the dir lease) | 6 | 266 | 99 | 33 | wins on pairs, by 8 | three of its cells were assigned by reasoning; its lead is 8 pairs on reads and writes no second agent checked; P `split` + merge needs 37 rules against `slot`'s 28 ([E-17c]), which rule 3 does not count |
| PD+fix | 0 | 4 | 238 | 119 | 13 | wins on the count (0 against 3) | its DATA-01 (data is the state engine) is open only because the judges read it as "the rows equal data's fold", while both wrote that data is not the engine on PD's servers; section 10 asks to re-rule it failed (structural), which puts PD+fix out |

The skeptic who raised these also priced a split row with neither dormant groups nor project groups at 2 novel mechanisms. That row has no way to keep an idle resource small: without dormant groups a group per resource cost about 86 KB against SC-13's 2 KB ([E-36], measured; A-15), and no SPACE option lets split groups hold many resources. So it is not counted here.

**Close calls in the mechanism count** ([MECHANISMS.md](MECHANISMS.md) sections 2 and 4).
- **The `memory` rung, planner hints and the slow-leader rule in the leader's own form.** Counter b judged each novel; counter a and the referee did not. COMP2 carries only the first; it takes hints as inputs to its controller and the slow-leader rule in the controller's form (TiKV PD's evict-slow-store, cited in MECHANISMS). Counted b's way, COMP2 has 3 and COMP 5, so the close calls only widen COMP2's lead.
- **`dir-lease`** (one process per dir, with an epoch fence) is novel because no counter placed a precedent; the referee knows an unchecked lead (HBase). It is in 16 rows, COMP2 among them, so no order changes.
- **Log replicas** (SPLIT's, DRAFT's, CELL's, LANE's witness that leads only to repair) have a precedent this page found at its source: TiKV's witness RFC, which lets a log-only replica be elected only to send the latest log to a lagging voter, refuse reads and writes while it leads, and hand leadership on (section 10). Judged not novel, they move DRAFT to 5, SPLIT to 4, CELL to 4 and LANE to 3. **Dormant groups** and the **dedup window** keep leads that were not checked (TiKV's hibernate regions, CockroachDB's quiesced ranges; Kafka's producer sequences and NFSv4.1's session slots as parts). None of these is in COMP2: they move SPLIT, DRAFT, CELL and LANE only, and COMP2 keeps the win with any of them (computed here).

**In short.** Among the judged rows, COMP's win holds under either judge and both counters, and its lead over SPLIT is wider than OUTCOME's sweep shows once SPLIT's merge is counted. But COMP is not the rule's best row: COMP2 beats it on cells the judges already scored. COMP2's own lead rests on one model-checked SHOULD, on 19 pairs, and on a rule that does not look at open MUSTs, which is why two unjudged rows rank above it.

## 5. The winner: COMP2

**Its full line** (AMENDMENTS section 4's table for COMP, with C and Z changed; a `*` marks an option a fix of AMENDMENTS section 1 changed):

| Id | R | G | P | K | C | V | Q | D | O | T | X | S | F | W | U | H | L | I |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| COMP2 | raft* | pslot | slot*¹⁴ | lib | cent-co*¹⁵ | +lrn | mix¹³ | sess*¹⁶ | slot* | clamp* | saga* | jrnl* +tier¹ | all | any* ridx | any | emb | ts→rs* | port |

| Id | Y | M | Z | N |
|---|---|---|---|---|
| COMP2 | fwd | kw* | par¹⁷ | proc |

¹ An object store is required across boxes. ¹³ `maj-d` by default; `maj-m` and `none` per resource, never per write, because G `pslot` cuts groups by durability. `maj-m` is there only because the user's list of accepted competitor-default losses is empty; no measurement yet shows it winning its row (section 3). ¹⁴ 4,096 slots, with 1,024 the fallback. One give-up decider (A-17). Moves are proposed one at a time, with a strict-improvement margin (A-18). ¹⁵ One loop on `#meta`'s leader heals each group's replicas and proposes slot moves, as in MIN-P, with A-20's epoch check, two re-checks of who is alive at the group's leader, and a timeout. Platform hints (DEP-17) are inputs to that loop. The slow-leader rule takes the controller's form. ¹⁶ With `srchi-slot` marks (A-05) and caller keys (A-10). ¹⁷ PAR's repair inside Raft ([E-37], 7 rules, each needed): a checksum per entry; a replica with a bad entry keeps its id, refuses to vote or stand, and copies the entry from a peer that knows it committed. The disk incarnation stays for the `memory` rung's unclean stop.

**In one line.** MIN-P with a `memory` rung beside `persisted` and `none`, and with `par`. In everyday words: Raft (a port of etcd's Raft, membership on commit, learners), groups owned by the project that hold slot sets of many resources, one controller loop on `#meta`'s leader that heals and moves, one journal per process plus an object-store tier, client sessions for exactly once, writer time as the median of the members' clocks, sagas with fenced locks for work across partitions, reads from any replica, `data` folding rows in the app's own process, TypeScript first and a Rust core later.

**What it gives up against COMP** (all reasoned or measured, none counted by rule 3): 4 more healing rules and a stuck state as first written that A-20 removes; while `#meta` has no leader, healing as well as moves waits (24 to 62 % of the judged states could not finish healing then, a delay and not a stuck state); 9 of the controller's 21 mutants are undecided ([E-16], G-09); and `par` costs 7 rules against `rejoin`'s 2 and was checked with three voters and no voter change (G-15). It drops COMP's K-27 (no one decides a give-up) because the controller decides, and turns K-07 into the controller healing and moving at once (both reasoned).

**Its score** (COMP's scorecard, [judging/rows/COMP.md](judging/rows/COMP.md), with F-22 (S) met): as worded, 6 MUSTs failed (F-05, F-15, F-17, P-05, SC-03, SC-10), 92 open, 34 met; restated, 0 failed, 97 open, 35 met. SHOULDs: 6 met (the five of section 3 and F-22 One bad entry), 3 not met (DEP-15 Two copies survive a crash, which needs a witness COMP2 does not have; DEV-02 (S), at most 10 pairs; P-15 (S) Transactions across partitions), 7 open. Novel mechanisms: 3 (the slot move, the restore mark in the store's manifest, the dir lease). Interacting pairs: 274.

Its PERF-04 is open, not met. No measurement shows any rung winning JetStream's default single-publisher row: E-02's `memory` rung read 0.57 ms in TS and 0.33 ms in Rust (0.33 to 0.35), both at 50,000 writes a second with no client hop and no gateway, and neither beats 0.55 ms by JetStream's 0.247 ms spread ([E-09b], [E-02]). An empty loss list rests on a hope, not a number. E-02 never ran one write in flight, so it is not a ceiling for this row either, and the cell stays open.

**Every MUST it leaves open** (restated; 97), grouped by what closes it first. Each line is from the "What closes it" column of [judging/rows/COMP.md](judging/rows/COMP.md), whose cells COMP2 shares; lines that name COMP's leader healing take MIN-P's closer ([judging/rows/MIN-P.md](judging/rows/MIN-P.md)) or say what changes.

*A choice of the user's comes first (13).*

| Requirement | What closes it |
|---|---|
| P-02 Cache with expiry, session store | the user's reading of the expiry bound (section 8); then the expiry-tick pin at 1e3 to 1e6 rows (phase 2) |
| F-07 Restart in any order | the user's reading of the two-voter window; then v4's stopsOneByOne harness on the port, with a stop inside that window (phase-2 sim) |
| SC-03 Scale writes up | SC-03 restated with the app split and F_w at most 135; then the phase-4 sim with the real mover at n = 1 to 32, and the 1-to-4-process pin |
| SC-10 Only stated ceilings, each above its floor | restated as SC-03; phase 1 fixes the list of ceilings and the slot count (4,096, or 1,024 if the cursor is too big); each phase pins them |
| SC-13 Many resources | the user defines "small" (few slots touched); phase 1 fixes the formats; the sim that makes and drops 1e5 resources through `fero()`; K-04 and K-06 |
| SC-14 Region scope | the region scope; the phase-2 sim with 80 to 150 ms links |
| SC-15 Sizes and neighbours | whether 1.18 and 1.26 times against 1.2 counts as met; E-35's load inside one Raft group, and the 1 MB, 64 MB and `too-large` tests (phase 2) |
| F-05 Failover time | the handover bar restated (or re-ruled open, section 10); pins on three processes with A-02's constants (phase 2) |
| F-15 Outside services | slot moves added to F-15's list, or the mark moved; a sim with the store down for 1 h (phase 3; K-21, K-23) |
| F-17 Partial partitions | F-17 restated, or read the clique way; the 3- and 5-node sweeps and one real-TCP run with CheckQuorum every E/4 and 0.25 E jitter |
| SC-08 Without worry | (b) restated, or the move cut to one or two commits and modelled with its carried set (K-03, K-25) before phase 1; the phase-4 sweep with scale events |
| DEP-17 The platform is the planner | whether a hint may change membership; a model or sim of the controller with stale, duplicated and reordered hints (K-08) before phase 2 |
| DEP-21 Cost is a number | where the 100 subscribers run, in which region, and whether the platform's Fly organization has granular data-transfer rates; the AWS prices read at the source; E-41's cost.py run again with Fly's transfer to the object store (section 6) |

*A model to write first (8).*

| Requirement | What closes it |
|---|---|
| P-06 Pub/sub | the `none` rung built and its failover rule modelled (K-10); then `nats bench` and `nats latency` through E-45's NATS gateway (decision 21 puts the rung in phase 5) |
| F-08 Deleted rows stay deleted | a restore model with removes; the phase-2 sim monitor seeded with v4's two row-comes-back bugs |
| F-12 Majority loss | a model of unclean recovery with lock fence tables, the `memory` rung (K-09) and `par`'s repair; recovery tests in phase 3 |
| F-18 Fail-slow | build and model the slow-leader rule in the controller's form (K-17); then the sim with per-node latency and one dm-delay or io.max run (phase 2) |
| DEV-02 Few interactions | models for COMP2's 79 open pairs: MIN-P's 61 (pairs.md sections 7 and 9: K-01 to K-28, FORKPIN, WTAIL, SRCMOVE, PREVOTE, RESTORENAME), 11 of the `memory` rung (K-09, K-05) and 7 of `par` (K-24 and the rest, section 7) |
| DEV-03 Model before code | phase-1 models of PreVote and CheckQuorum with voter changes, quiet groups with failure detection, the dir lease and the slow-leader rule; the slot move's smallest TLA+ model re-run for the 85 % mutant bar (G-07); the controller's undecided mutants (G-09); `par` with a voter change (G-15); `pslot`'s placement rules (K-04, K-05); K-07's controller form, K-08, K-09 |
| TEST-03 Input keys | E-20's model with a keyed call added (G-12); phase 1's retried-call chaos phase |
| TEST-06 Forks cost a record | a model of the fork's cut; a fork of a 1 GB resource that writes under 1 KB (object-store phase) |

*A build and a measurement: phase 1 (20).*

| Requirement | What closes it |
|---|---|
| SC-01 One process, no setup | examples 01 and 02 timed on the v5 solo node (ready time, RSS, idle CPU), kept as pins |
| DATA-01 data is the state engine | data's merge contract (A-10, a SCHEDULE_VERSION bump); then the sim monitor that compares folds on the real kernel |
| DATA-03 Records are the wire | the record header and value encoding fixed, with codec round-trip tests in both repos |
| DATA-04 The SCHEDULE contract | data's side: a digest a test forces to move with the fold, the merge clause and the bump; then `test:contract` in the v5 battery |
| DATA-06 Faults stay in user land | V4-47's tests re-run on the v5 composer at each place data closes a commit (phases 1 and 2) |
| DATA-08 data's perf rides along | CI on a pinned quiet runner that runs data's perf suite on every change to a data path |
| DEV-06 Layer contracts | LAYERS.md's interfaces and invariants, a timed suite per layer under 30 s, CI in which each repo pins the other's commit |
| DEV-07 Deterministic | the determinism canary on the real kernel; sim traces checked against etcdraft.tla and the slot-move spec |
| DEV-08 Bug flow | STATUS's weekly bug counts from phase 1 on |
| DEV-09 Shapes fixed early | positions, cursors, record header and layer interfaces fixed; each later interface diff checked to be additive |
| DEP-05 Seeds once | v4's revived-seed-row case as a regression test, with a crash between the catalog entry and the seed rows, and two creators at once |
| DEP-06 Addresses | IPv6 in brackets everywhere, listen apart from advertise, a changed private address |
| DEP-09 The supervisor owns secrets | a supervisor layer above the call for secret, address and dir |
| DEP-13 Small copies | memory pins: an empty process, and 10,000 small rows in 256 MB |
| TEST-04 Worlds | L4's bind tests on the config layer |
| TEST-09 App steps in the simulator | the café of "fero test" under `--schedules` on the real kernel, with the planner as a sim client |
| OPS-03 Config | the config tiers kept; range and cross-key tests once `fero.alter('#meta')` is built |
| OPS-09 One owner per dir | V4-59's tests ported, and a wrong-project test |
| OPS-11 Debugging in production | the recorder in L0's format, with one recorded run replayed in the sim; later the metrics, trace context and slow-op log |
| OPS-12 Upgrades both ways, and the fold's version | the record header with the five pins; a roll across two builds and two data versions with the hashes of F-21 (Divergence is caught) equal |

*A build and a measurement: phase 2 (32).*

| Requirement | What closes it |
|---|---|
| P-01 Live shared state | the persisted-write p99 pin on the real kernel (the same pin as PERF-08, Commit latency), and example 02 on three real processes |
| P-11 Counters and rate limits | the pin for a conditional op at the writer on the real L2 (the pin of PERF-10, Reads and ops) |
| P-22 Delayed jobs, waiting takes, priorities | the writer-time stamp op in L2 (a phase-1 API shape), then the waiting-take wake pin |
| PERF-01 Fair comparison | a real kernel behind E-45's gateways, each competitor's own tool in the same hold; the native step for the single-client tail rows |
| PERF-02 Redis 7 | memtier through the RESP gateway: about 92,000 persisted SETs/s at 200 connections with p99 under 4.9 ms; the pipeline-16 default rows need the `memory` rung or the native step |
| PERF-04 NATS JetStream | `nats bench js` with one write in flight: `persisted` against sync always, `memory` against JetStream's default, below about 0.30 ms to count as a win; the native step if TS does not get there |
| PERF-05 Kafka | Kafka's own tools through the Kafka gateway, 16 partitions, same hold; a 1 KiB `memory` run for the default max row |
| PERF-06 Redpanda | Kafka's own tools against Redpanda, same hold; TS must keep 62 % of the protocol-free ceiling, so likely the native step |
| PERF-07 etcd | etcd's `benchmark` through the gRPC gateway; the one-client put p99 must come under 1.73 ms |
| PERF-08 Commit latency | p99 commit at 50,000 writes/s on the pipelined kernel with the real Raft core, `fio` floor beside it; the native bar at the native step |
| PERF-10 Reads and ops | pins for the conditional op, the method call at the writer, the held-row read and the `fresh` read (phases 2 and 3) |
| PERF-13 Nothing on a timer grows with data | CPU per tick of retention and compaction at 1e3, 1e5 and 1e7 rows |
| DATA-07 Rows handed out are immutable | the mutation test over every hand-out path, with the held-row read pin |
| SC-02 Same code at every size | the example series unchanged on 1, 3 and 5 processes (phases 2 and 3); a hosted run |
| SC-07 Members | the sim sweep at n = 1 to 100 with failures injected |
| SC-09 Limits warn before they bite | one test per limit as each lands: disk in phase 2, the rest by phase 4 |
| F-06 No false failovers | the sim with pauses up to 1 s on kernel threads and CheckQuorum at E/4 (K-28), and the median with one or two clocks and a changing member set (K-11) |
| F-09 Every loss is said | one test per failure kind; the sim monitor for silent waits over 2 × election.ms (phases 2 and 3) |
| F-10 Disks | the sim's disk model, or a block-level tool (dm-flakey, dm-log-writes), for a failed fsync and a lost directory entry |
| F-13 Bounded | one test per bound; the 24 h soak at max rate in phase 4 |
| F-16 Returning members | the sim's partitions from 10 s to 1 h with retention and snapshot catch-up; a pin on the bytes copied after the log was cut |
| F-19 Overload and storms | E-39 rerun with a server grant and many clients; 1,000 groups failing over; the storm behind a TLS terminator (phases 2 and 3) |
| F-21 Divergence is caught | one wrong fold injected on one replica, reported within one check period (K-20) |
| DEP-01 Rolling deploy | J's four-roll test on real hosts, with A-02's refuse-at-once handover |
| DEP-02 Caught up is a number | v4's early-writable case as a regression test |
| DEP-03 Restart all | J's restart-all run, with a stated rule for who campaigns first |
| DEP-04 Sleep and wake | the wake test on the hosted platform: a real machine start, writes held during the wake |
| DEP-08 Clients leave shut servers | a member that cannot forward refuses at once, and the client moves in one retry |
| DEP-11 Write gate | the project gate and the memory bound, with reads served meanwhile |
| DEP-16 A lost host loses nothing acknowledged | the host-loss test, and a stated loss window for the one-disk free copy |
| OPS-02 Health is complete | one health test per failure kind, with F-09's monitor |
| OPS-08 Numbers for machines | the API test on a real server |

*A build and a measurement: later phases (22).*

| Requirement | What closes it |
|---|---|
| P-08 Consumer groups | the rebalance-time pin on the group library (the phase that builds L5) |
| P-12 Leaderboards, live aggregates | data's contract change (merge contract, per-row `group` deltas), then data's pins and the merged-partials test |
| P-16 Event sourcing, CQRS | data's contract change and the view rule (A-10), then the rebuild test |
| P-18 Tapes, forks, replays | the fork on the snapshot and segment store (fero test phase), with TEST-06's pin and the cut per partition across groups |
| P-20 Change the shape of rows | P-16's contract; a tape replayed across a shape change; the migration on example 43 under load |
| P-21 Request and reply | a service on the `none` rung timed with `nats bench` request/reply; or the bar restated as three commits (E-22 D7) |
| PERF-03 NATS core | `nats bench` and `nats latency` through the NATS gateway on a real `none` path (the relay phase); the native step if TS stays over NATS's 0.27 ms p99 |
| PERF-14 Never widen | a pinned quiet runner, each bar entered as a pin in `npm run perf`, then the CI history |
| DATA-05 Views are data's operators | data emits per-row `group` deltas and shares equal views; then P-12's pins |
| SC-04 Scale down | the 7-day daily-load-cycle sim with the real mover and its thresholds (phase 4) |
| SC-05 Scale to zero and back | a built wake path (native crc32c, blind writes while the fold catches up) timed at 10 GB; then sleep and wake with disks kept and lost (phase 4) |
| SC-11 Hosted, many tenants | two projects on the deploy target's volumes under E-35's load, one at quota; 1,000 sleeping projects on the box (platform phase) |
| DEP-07 One public address with TLS | the client test through one proxy address with a TLS terminator (phase 3) |
| DEP-10 Contracts before the roll | the deploy test with a changed rule and A-10's five pins (phase 3) |
| TEST-08 Captures line up | the viewer test on v5 captures (debugger phase) |
| OPS-04 Debugger | the DOM gates on v5 captures and a live cluster (debugger phase) |
| OPS-05 Mixed versions | the roll test across two kernel builds |
| OPS-06 Security | door and TLS tests, and a rotation under load (security phase) |
| OPS-07 Backup, restore and point in time | a restore to a past position with an outside token holder, and an export round trip (object-store phase) |
| OPS-10 Per-user access | the hostile-client suite, a revocation under load, the 2 µs pin |
| OPS-13 Erase | erase tests across every store; a deleted project's bytes unreadable once its key is gone |
| OPS-14 A shared tier keeps projects apart | a key per project at rest and a cross-project read attempt (object-store phase) |

*A build and a measurement: the native step (2).*

| Requirement | What closes it |
|---|---|
| DATA-09 A native kernel keeps data | the differential test against data on E-43's stream, 1e6 records, state compared |
| TEST-10 Same kernel bytes | a Rust core that passes etcd's files, then A-30's guard over 1,000 seeds; or the Rust kernel run as WASM in the sim. raft-rs 0.7.0 cannot run etcd's files (G-24) |

## 6. Every other row

"Novel" is counter a / counter b / settled (MECHANISMS section 2); the settled list of each row's novel mechanisms is there. Places in A are OUTCOME A.2's.

| Row | What it is (SPACE 4.2) | Novel | A: place (MUSTs failed) | B | Why it does not win |
|---|---|---|---|---|---|
| COMP | the study's composite: leaders heal, Z `rejoin` | 3 / 5 / 3 | 5 (6) | in, 1st of the judged rows | rule 3 against COMP2: the same 3 novel mechanisms, 5 SHOULDs against 6 (F-22 S) |
| SPLIT | groups that split by size and load, with no controller | 5 / 7 / 5 | 3 (5) | in, 2nd | rule 3: 5 novel mechanisms against 3 for COMP and COMP2. Its pairs are 295 with the merge its SC-04 relies on; without the merge SC-04 fails (section 3) |
| DRAFT | DESIGN-V5 as of 2026-11-05 | 6 / 8 / 6 | 3 (5) | in, 3rd | rule 3: 6 against 3; it also loses to SPLIT on pairs (309 against 278) |
| MIN-P | MIN with groups owned by the project | 3 / 2 / 3 | 9 (7) | out on PERF-04 | PERF-04: only `persisted`, which cannot beat JetStream's default by PERF-01's spread rule (section 3). Let back in, it would win among the judged rows (OUTCOME B.4), and lose to COMP2 on F-22 (S) |
| MIN | DRAFT minus the witness, the planner, the group rule and window dedup; one controller loop | 4 / 3 / 4 | 9 (7) | out on PERF-04 | PERF-04, as MIN-P. Let back in alone, it would win among the judged rows; against COMP2 it places 3rd |
| RUST | MIN with a Rust core and raft-rs from day one | 4 / 3 / 4 | 9 (7) | out on PERF-04 | as MIN |
| SRV | MIN as a Rust or Go server binary | 4 / 3 / 4 | 6 (6) | out on PERF-04 | as MIN (4th against COMP2) |
| LEAN | MIN where only leaders fold | 4 / 3 / 4 | 9 (7) | out on PERF-04 | as MIN |
| MIN-TS | MIN in TypeScript for good | 4 / 3 / 4 | 9 (7) | out on PERF-04 | as MIN |
| RLOG | Raft on log members; a server writes by a committed writer epoch | 4 / 4 / 4 | 6 (6) | out on PERF-04 | as MIN (4th against COMP2) |
| EMB-V8 | SRV with V8 embedded | 4 / 3 / 4 | 6 (6) | out on PERF-04 | as MIN (4th against COMP2) |
| SIDE | MIN with a native daemon per host | 4 / 3 / 4 | 9 (7) | out on PERF-04 | as MIN (4th against COMP2) |
| SLOG | the earlier log-first draft, with slots | 5 / 4 / 5 | 2 (5) | out on PERF-04 | PERF-04, as MIN-P. Let back in, it would place 4th among the judged rows (5 novel against 3) and 7th against COMP2 |
| ISR | Kafka's shape: leader and in-sync set under a controller | 2 / 1 / 2 | 1 (4) | out on 3 | SC-03 and SC-10: a fixed partition count, hashed, gives 23 to 53 writers' worth at 64 groups under skew even with the app split ([E-18], a ceiling), and SC-03 forbids a count chosen up front; SC-04: no rule merges a group (structural) |
| LANE | 64 lanes per project | 4 / 5 / 4 | 9 (7) | out on 4 | PERF-04 (as MIN-P); SC-03 and SC-10: 64 lanes shared by a project give one resource 23 to 53 writers' worth ([E-18]); SC-04: no rule removes a lane (structural) |
| CELL | 16 cells per resource, re-keyed to grow | 4 / 6 / 5 | 16 (8) | out on 5 | P-07 (Streams and replay): a re-key refuses old cursors (structural; [E-17], [E-31]); SC-03 and SC-10: 7 to 15 writers' worth ([E-18]); SC-08: a write to a partition that never moves waits for the re-key ([E-17c], counterexample); OPS-01 (No numbers to choose): a person picks the cell count (structural; depends on F_w) |
| PD | TiKV's shape: split and merge, a controller, timestamps, two-phase commit | 0 / 1 / 0 | 17 (8) | out on 3 | PERF-04 (as MIN-P); SC-05 (Scale to zero and back): state on local disks with no tier, so a wake after lost disks keeps nothing (structural); F-22: with no checksum per entry, a committed write is overwritten in 32 states ([E-37], counterexample). Section 10 asks to fail its DATA-01 and DEP-21 too |
| OBJ | the object store is the log | 2 / 2 / 2 | 18 (9) | out on 7 | P-01: every commit is a conditional PUT, p99 about 80 ms on S3 Standard and at least 7.3 ms on Express One Zone, against 5.7 ms (structural; [E-28]); P-05, PERF-04, PERF-07, PERF-08: ceilings from MinIO's 2.67 ms PUT p99 here; F-15: a store that is down stops writes (structural); DEP-21: about $136 a month against $10 ([E-41]: $135.80; the price check: $136.02 to $136.39) |
| BUY | fero's upper layers on NATS JetStream; a reference row | 0 / 0 / 0 | 19 (28) | out on 27 | 18 structural, 7 ceiling, 2 counterexample. E.g. TEST-10 (Same kernel bytes) and DEV-07 (Deterministic): the sim cannot run nats-server's bytes; F-02 (Exactly once per attempt): a retry lands twice once JetStream's dedup window has passed ([E-44], measured); PERF rows: it cannot beat what it is built on |
| V4 | v4 as it is | 8 / 11 / 8 | 20 (50) | out on 50 | 46 structural, 3 ceiling, 1 counterexample. E.g. P-14 (Invariants): two sells of the last item through two servers both answer ok (v4 measured); F-01 (No lost acknowledged write) and F-02: pinned red in v4's own sim |

**The unjudged rows** (computed here; section 1):

| Row | Novel | SHOULDs met | Pairs | B | Where it stands |
|---|---|---|---|---|---|
| COMP+par | 3 | 6 | 293 | in | loses to COMP2 on pairs (293 against 274). With rules in place of pairs as the last tie-break it would win (leader healing: 14 rules against 18) |
| MIN-P+m | 3 | 5 | 264 | in | loses to COMP2 on F-22 (S) |
| MIN-P+par | 3 | 6 | 261 | out on PERF-04 | wins if the user accepts JetStream's default loss |
| SPLIT2 | 3 | 6 | 266 | in, on copied cells | ranks above COMP2 by 8 pairs; not judged (section 4) |
| PD+fix | 0 | 4 | 238 | in, on copied cells; out if PD's DATA-01 is re-ruled | ranks above every row by the count; 119 MUSTs open; not judged (section 4) |

**DEP-21's written reasons.** DEP-21 asks this page to give a reason for each row that costs more than twice the cheapest at any load. On Fly ([E-41], cited prices; the price check of section 10 re-read Fly's and Tigris's prices at the vendors' own docs sources and moved the ratios only slightly):
- **OBJ**, at both loads (27.5 and 17.5 times in E-41; 24.6 to 27.1 and 4.8 to 17.6 times in the price check): every commit window is a PUT, about 26.3 million PUTs a month at 10 writes a second.
- **SRV, PD and BUY at 10 writes a second** (2.4, 3.7 and 3.2 times in E-41; 2.2 to 2.4, 3.4 to 3.7 and 2.9 to 3.2 in the price check): the app runs on machines of its own beside the servers, and PD adds three placement-driver machines.
- **Every row that keeps a day of log in the object store, at 5,000 writes a second, if Fly bills the upload at $0.02 per GB** (the price check: Fly says transfer to Tigris is billed, at a rate it does not name): the upload, 13,140 GB a month, then costs more than the machines, and those rows come to $342 to $393 against BUY's $136, which uploads nothing. BUY is the reference row and not the base of E-41's ratio. Compression, or less log kept in the store, would cut it (reasoned).
- COMP2 has MIN-P's shape: $7.26 a month at 10 writes a second in E-41, $7.36 to $7.89 in the price check, under the $10 bar in Fly's cheapest regions and in J's first ones (iad, ams), but over it in São Paulo ($11.86 to $12.52) and Johannesburg ($10.70 to $12.54). Same-region traffic is free only for a Fly organization on granular data-transfer rates.

## 7. DEV-02 and the models

**Pairs, and where each sits** ([pairs.md] section 4, after the second agent's check; shares computed here):

| Row | Pairs | In an exhaustive model | In a simulation only | Argued independent | Open | Placed (model or argument) |
|---|---|---|---|---|---|---|
| COMP2 | 274 | 79 | 29 | 87 | 79 | 195 (71.2 %) |
| COMP | 283 | 76 | 29 | 91 | 87 | 196 (69.3 %) |
| SPLIT | 278 | 59 | 25 | 88 | 106 | 172 (61.9 %) |
| DRAFT | 309 | 73 | 29 | 100 | 107 | 202 (65.4 %) |
| MIN-P | 252 | 76 | 29 | 86 | 61 | 191 (75.8 %) |
| ISR | 214 | 16 | 20 | 96 | 82 | 132 (61.7 %) |
| SLOG | 272 | 38 | 24 | 123 | 87 | 185 (68.0 %) |

COMP2's line is MIN-P's 252 pairs as pairs.md places them, plus 22: the `memory` rung's 12 (pairs.md places 11 open, under K-09 and K-05, and 1 argued independent, with `forks`), and `par`'s 10, which pairs.md does not hold because no row carried `par`. Of those 10, this page places 3 in a model ([E-37] runs `par` inside etcd's Raft spec with its log, votes and commit; reasoned here) and leaves 7 open (the journal, which is K-24, the tier, the disk incarnation, the dir lease, the recorder, the snapshot and the `memory` rung). SPLIT's line leaves out the 17 pairs of its merge (section 3), none placed.

- **DEV-02's MUST** (each pair inside one model or shown independent) is **open for every row**: every row has open pairs, and no model found a counterexample. **Its SHOULD** (at most 10 pairs) is **not met by any row**: the smallest is BUY's 12, and every v5 row that runs its own kernel carries 144 or more (V4 carries 52).
- The "Pairs" column is the count rule 3 uses. The open column shows where the risk sits, and rule 3 does not use it.
- **COMP2's open pairs** sit mostly where a mechanism was never built or modelled: the `memory` rung (K-09), hints and leaves (K-08), the slow-leader rule (K-17), quiet groups (K-22) and `par` beside the journal (K-24); the rest spread over about two dozen other closers ([pairs.md] sections 7 and 9). The second agent broke six of the first agent's arguments and moved 42 distinct pairs to open: among them FORKPIN (a fork pinned in `#meta` while the parent drops its log), WTAIL (writer time across a new leader's inherited tail), RESTORENAME (an upload after a restore at an offset the old history used), SRCMOVE (a consumer whose source slot moves) and PREVOTE (PreVote and CheckQuorum with a voter change).

**The composed model of the riskiest crossing** ([crossing/README.md]; model-checked here):
- **What it held.** One slot move from group A to B, a leader change, a voter swap in A or B, a log drop behind a snapshot, and the dedup state the move carries (session floor and outcomes, the highest lock token, the `srchi-slot` mark), in any order. Every property it checks held on 28 bounds explored in full (up to 2,612,006 states, each within DEV-03's hour), with liveness, and on the review's two reader bounds with two writes. Three bounds stopped short with no counterexample (`any` and `all` at 2.5 million states, the review's two-crash bound at 3 million); a partial bound is not a pass.
- **Which rows it covers.** It models leader healing (C `self`) and client sessions: COMP's picks. It covers a controller row such as COMP2 or MIN-P only through a reduction the second agent checked in writing: the controller changes a group's config only through the group's leader, under healing's own guards, so it reaches only configs that leader healing reaches ([pairs.md] pairs 216 and 227, and section 9; reasoned).
- **What it found.** One counterexample that neither single model could find: in 6 steps, a write is both applied and told "refused". The fix is E-20's own rule on one more path: never judge a copy below the session's floor (precedent: the Raft thesis, section 6.3). It also turned three things into rules: a snapshot keeps the floor, the outcomes, the mark and the highest lock token beside the rows (5 to 20 steps to a duplicate without each); the move carries the floor and the mark (16 to 19 steps); every path that judges a copy checks the floor first. 20 of the 24 rules added at the crossing are needed. No new mechanism.
- **What is left open.** Mutants: 95 of 136 caught (70 %), under DEV-03's 85 % (85 % where dedup meets the move and the log drop). Every bound run in full has one member fault, so no election ever meets a voter behind the log. Not in the model: E-15's slot table, E-31's subscribe protocol, the loop on `#meta`'s leader that proposes moves (K-07; for COMP2, the controller that heals and moves at once), the `memory` rung (K-09), `par` (G-15, K-24), a restore (K-13, K-14, K-23), writer time (K-11, K-12), the object-store tier (K-21), many resources and 4,096 slots (K-04 to K-06, K-15, K-25), hints and leaves (K-08), the slow-leader rule (K-17) and quiet groups (K-22). The `win` rows (DRAFT, LANE, SPLIT, SLOG) were not checked; by reasoning they owe the same floor rule, so their F-02 should be open, not met (section 10).

## 8. What the user must confirm

Items 1 to 14 are AMENDMENTS' list ("For the user to confirm"), in its order; items 15 to 22 are the other choices in OUTCOME's "what flips the winner" or in MECHANISMS 4.5; items 23 to 26 come from the skeptics (section 10). "A" and "B" are the two outcomes. Items 2, 5 to 8, 11, 15 to 17 and 23 to 26 can change a winner.

| # | The question | Options | What each does to the outcome | Which way the evidence leans, and why |
|---|---|---|---|---|
| 1 | F-06 (No false failovers): may a leader's clock jump cause a failover? | no, so writer time is the median (A-23) / yes, so CockroachDB's guard | no cell depends on it; the winner does not move | the median: both need 7 rules, and the guard fails over on every leader clock jump (60 of 60 runs, [E-21], simulated) |
| 2 | PERF-01: which competitor-default rows may fero lose, by name? | none (proposed) / PERF-04's default single-publisher row (and PERF-02's and PERF-05's default rows) | none: COMP2 in B (COMP among the judged rows), ISR in A. Accepted: MIN-P+par in B (MIN-P among the judged rows), ISR and SLOG level in A. The `memory` rung exists only for this; the strict reading is what puts the simpler row out | neither is proven. The loss of `persisted` holds by PERF-01's own spread rule (a win needs below about 0.30 ms). The `memory` rung has no winning number either: 0.57 ms in TS and 0.33 ms in Rust, at 50,000 writes a second, with no client hop or gateway ([E-02], [E-09b]); its safety is not modelled (K-09). An empty list rests on an untested hope |
| 3 | The order in rule 3 (Z, V) | as written: one more SHOULD beats one more mechanism / rule 4: fewer novel mechanisms first | both give COMP2: `par-repair` is settled not novel (MECHANISMS 4.2), so `par` adds no novel mechanism and meets one more SHOULD. Only ranking rules (7 against 2) or all mechanisms before SHOULDs would keep `rejoin`, and no judging rule does. A witness does not join: DRAFT's and SPLIT's DEP-15 (S) is open, not met, so a witness adds a novel mechanism and no met SHOULD | `par` is model-checked for F-22 (S) with three voters ([E-37]); it was not checked with a voter change (G-15) or on one journal per process (K-24) |
| 4 | DEP-17 (The platform is the planner): may a platform hint change membership, or is it advice? | change / advice | no cell depends on it. Under COMP2's controller a hint is an input to the loop that already carries A-20's re-checks; K-08's model is owed either way | no experiment decides it; advice keeps hints off the membership path ([E-16], reasoned) |
| 5 | SC-10 and SC-03 with F_w: restate with the app split, and what is F_w? | as worded / restated, F_w = 64 / restated, F_w above 135 | as worded (alone): every row out, level at the top. Restated with F_w up to 135: COMP2. F_w above 135: SPLIT (reasoned from the cells). At the 1,024-slot fallback a slot row states 72 | restate: no design reaches 64 without a split of hot partitions ([E-18], simulated); 135 at 4,096 slots, never run on the box |
| 6 | P-05: restate the delivery bar? | as worded / a window per room and about 1,000 sockets a core | as worded (alone): every row out, level at the top. If P-05 is re-ruled open as worded (section 10), the restatement matters only to the bar the build will meet | restate: measured over the bar in both languages at E-08's working point ([E-08]) |
| 7 | F-17: restate, or add an election rule? | as worded / "a connected majority that includes an up-to-date replica" / a new election rule | as worded (alone): every row out, level. A new rule adds 1 novel mechanism to every Raft row alike, so it changes no order among them (reasoned) | restate, as E-38 recommends ([E-38], simulated on etcd's Raft); see item 23 for the reading of "connected majority" |
| 8 | F-05's handover bar and SC-08(b) | restate both / cut the move to one or two commits / keep | F-05 as worded (alone): SLOG first by rule 2 on the cells as they stand; no effect if F-05 is re-ruled open as worded (section 10). SC-08 stays open either way | restate F-05: etcd misses 10 ms at the tail here, inside the disk's own stalls ([E-13]); for SC-08(b) cut the move: one commit measured at most 4.7 ms ([E-13]), not yet modelled |
| 9 | SC-13's "small", and N_res | "few slots touched" / per-slot state priced per touched slot; N_res 100,000 or other | no change: open either way for the leading rows | an idle `pslot` resource is 0.4 to 1.2 KB at 1 to 10 touched slots and passes 2 KB near 100 ([E-36], measured in Node) |
| 10 | P-09 (Work queue) and P-11 (D9): does "an empty take writes nothing" rule out "append every refusal"? | `forward.once` / append every refusal (3 fewer rules) | no change to the winner | no experiment weighed them; it is a reading of the requirement text |
| 11 | F-15: may a slot move wait while the object store is down? | yes, slot moves join F-15's list / no | yes: COMP2. No: SPLIT, but only while DRAFT's and SPLIT's restore mark has no home. If DRAFT's lives in the store, SPLIT is the only row in; if a split must also record its epoch before use, DRAFT, SPLIT, COMP and COMP2 are level. "No" can also be met by giving COMP2's mark another home. With item 2 the other way too: SRV on the cells as they stand, SPLIT once the `fero init` rows' mark is in the store | yes leans: only moves wait; writes and failover do not, and the mark before use is a needed rule ([E-33]). But no run had the store down (K-21, K-23), and no other home was modelled |
| 12 | A-23's agreement guard: when most clocks are wrong, stop or keep writing? | stop (9 rules) / keep writing by a wrong time (7 rules) | no change to the winner | the evidence prices both and picks neither: without the guard, 104 rows early, 370 late and 2 early lock grants in 30 runs ([E-21], G-11) |
| 13 | SC-15: is 1.18 and 1.26 times against a 1.2 bar met? | met / open | no change: open either way in the arithmetic | split: E-35's own answer is "holds, just", but one of its two sets of runs is over the bar ([E-35]), and big records inside a shared `pslot` group were never run (K-06) |
| 14 | J and a tier shared between projects (OPS-14) | yes, J says so (proposed) / no | no: DRAFT, SPLIT and six other rows fail OPS-14; among the judged rows only COMP stays in, and COMP2 stays in with it. The winner does not move | a shared journal at quota raised another tenant's p99 1.40 to 1.59 times against 1.1 ([E-35], measured), so a shared tier needs A-29's budget, not built |
| 15 | F-07: does the new voter count from the commit? | a two-voter group's stated limit (proposed) / a failure | failure: every Raft row fails; B becomes level at the top | the stated limit: the one-message window comes from Raft and every Raft row has it ([E-14b], [E-14c], model-checked: 6 and 4 stuck states) |
| 16 | P-02: is the expiry bound read by writer time while a writer exists? | writer time (proposed) / to the letter | to the letter: level at the top | writer time: no one-writer design meets the letter (2,036 ms late against 350 ms, [E-22]) |
| 17 | P-13: is the presence bound read by writer time? | writer time (proposed) / to the letter | to the letter: level at the top | writer time: 12.4 s after a `#sessions` failover in any one-writer design ([E-22]) |
| 18 | PERF-08 (Commit latency): judged in the TS phase or at the native step, for OBJ, BUY and V4 | as settled / the other way | no change: those rows are out on other MUSTs | none needed |
| 19 | DEV-01's bar: "below v4's 13", while v4's settled count is 8 | keep 13 / restate | no change: no row is near either number | none needed |
| 20 | SC-14 region scope | one region per group (proposed) / writes homed in several regions | no change: open either way | multi-region writes would need WAN bars no row was built or tested for |
| 21 | The fsync figure every latency bar is also stated against | a cited figure (proposed) / another | no change: open either way | E-01 could not prove the box's flushes reach the host's disk (G-22) |
| 22 | MECHANISMS 4.5's close calls: the `memory` rung, planner hints, the slow-leader rule; `dir-lease`'s unchecked HBase lead | as settled / stricter / accept the lead | no change: stricter gives COMP 5 and COMP2 3, so it widens COMP2's lead; the HBase lead moves 16 rows alike | the referee read the sources where it could (MECHANISMS 4.4) |
| 23 | F-17's "connected majority": one server with two-way links to a majority (E-38's star), or a majority in which every pair talks both ways (a clique)? | star / clique | A only. Star: as the cells stand. Clique: no counterexample, so F-17 as worded is open for the Raft rows (its 2E time waits on the sweeps re-run with CheckQuorum every E/4); with F-05 also open, A's first place is DRAFT and SPLIT, level (computed here) | F-17 does not define the term; E-38 records both and chose the star. All 5 stuck runs lack a clique ([E-38]'s results) |
| 24 | Rule 3's reach: may a row with more untested MUSTs outrank a better-tested one on counts alone? | as written: yes / a guard (for example, a built and run prototype, or a cap on open MUSTs) | as written: SPLIT2 (99 open) and PD+fix (119 open) rank above COMP2 (97 open) on copied cells. With open MUSTs counted before pairs, COMP2 beats SPLIT2 (97 against 99); PD+fix goes out only with a cap on open MUSTs or the DATA-01 re-ruling of section 10 | no requirement sets such a guard; rule 2 has the same blind spot in A (section 2) |
| 25 | Rule 3's last tie-break: interacting pairs (as written) or rules counted | pairs / rules | pairs: COMP2 (controller heals). Rules: COMP+par (leaders heal: 14 rules against 18, [E-16]) | the pair counts rest on one agent's reads and writes; the rule counts rest on E-16's model with one agent's count (G-09) |
| 26 | DEP-21's place and price: which region, and does the Fly organization use granular data-transfer rates? | J's first regions (iad, ams) / any region; granular rates / not | iad or ams with granular rates: COMP2's DEP-21 stays open. São Paulo or Johannesburg: MIN-P's shape (and COMP2's) passes $10. Without granular rates, 100 subscribers inside cost about $52.56 more, the same as outside | the price check (section 10): Fly's own docs source, read 2026-11-10 |

## 9. The next step

Settle the answer, then build the thinnest slice of COMP2 that runs end to end, break it under chaos, and time it with each rival's own tool. In this order:

1. **Before code: the user's answers, one judging pass, and four models.** The answers to the items of section 8 that can change a winner. A judging pass that scores COMP2, SPLIT2 and PD+fix as rows (and COMP+par, as AMENDMENTS section 4 asked), takes the re-rulings of section 10, and gives SPLIT its merge in the mechanism file. Then: (a) the controller that heals and proposes slot moves at once, with `#meta` down or changing leader (K-07's controller form), and its 9 undecided mutants (G-09); (b) K-09, the `memory` rung inside Raft when a majority stops uncleanly; (c) `par` with a voter change and on one journal per process (G-15, K-24); (d) the move cut to one or two commits with its carried set (K-03, K-25), and the slot move's smallest TLA+ model re-run for DEV-10's mutants (G-07). *Closes, in part:* DEV-02, DEV-03, SC-08, F-12, F-22 (S).
2. **The slice, in TypeScript.** E-10's port of etcd's Raft with A-01 and A-02; one controller loop on `#meta`'s leader that heals and moves, with A-20; one journal per process with its reserve and a checksum per entry with `par`'s repair; `pslot` groups and a 4,096-slot table in `#meta`; one slot move with its carried set and one give-up decider; client sessions with `forward.once` and E-32's three rules; writer time as the median; the `persisted` and `memory` rungs; `data` folding the records. Left out: the tier and restore, the `none` rung and relays, hints, the slow-leader rule, merged views. *Closes:* DATA-03, DATA-04, DEV-06, DEV-07, DEV-09, OPS-12 (their phase-1 parts), SC-01, SC-10's slot count.
3. **Chaos.** 1,000-seed sim sweeps with crashes, leader changes, voter swaps, a slot move, a log drop and one bad entry on each of two replicas; E-46's Maelstrom adapter with partitions and pauses (`--concurrency 2n`, an outside pauser, Porcupine beside Knossos); real Elle on the histories (TEST-13, Outside checkers; [E-22b]); E-29's LazyFS power-loss tier; v4's stopsOneByOne harness; E-38's partial-partition seeds with CheckQuorum every E/4. *Closes:* P-01 (its safety half), F-06, F-07, F-09, F-16, F-17 (restated), F-21, DEP-02, DEP-03, TEST-09.
4. **Timing against the rivals, in the same hold.** PERF-01's rule: same box, at least 3 runs, median and spread, under the CPU lock, the floors measured first (`fio` fdatasync p99 and the loopback round trip). Through E-45's four gateways ([E-45]) and the competitor drivers of [E-09a2], [E-09b], [E-09c], [E-09d] and [E-09e]: (a) the PERF-08 pin; (b) `nats bench js` (PERF-04), the row that decides whether the `memory` rung stays; (c) memtier through RESP (PERF-02); (d) etcd's `benchmark` through gRPC (PERF-07); (e) Kafka's own tools against Kafka and Redpanda (PERF-05, PERF-06). PERF-03 waits for the `none` rung. *Closes:* PERF-01, PERF-02, PERF-04, PERF-05, PERF-06, PERF-07, PERF-08, P-01, P-11, PERF-10 (in part).
5. **Failover and moves on three processes.** F-05's pins, the handover, the move's unwritable window, E-39 rerun with a server grant. *Closes:* F-05, SC-08's (b) pin, F-19, DEP-01, DEP-08.
6. **The native step** (`ts→rs`) for each row TS does not win: PERF-04's default row, PERF-08's native column, PERF-07's single client. The Rust core is still open: raft-rs 0.7.0 cannot run etcd's files (G-24). *Closes:* DATA-09, TEST-10, and those native columns.

**Results that would overturn this verdict.**

| Step | The result | The bar | What it overturns |
|---|---|---|---|
| 1 | the judging pass scores SPLIT2 or PD+fix with no MUST failed | none may, unless the user sets item 24's guard | SPLIT2 wins on pairs (266 against 274), or PD+fix on the count (0 against 3) |
| 1 | a model of the controller (K-07's form, G-09) needs new novel mechanisms that COMP+par does not need | fewer than 2, and fewer than 19 added pairs | COMP+par (leaders heal) |
| 1 | `par` fails a MUST with a voter change or on one journal (G-15, K-24) | no counterexample | MIN-P+m (COMP2 with `rejoin`) |
| 1, 3 | a counterexample where a slot move meets a membership change at two member faults (K-01) | none may | it hits every slot row at once (AMENDMENTS G-01), COMP2, MIN-P and DRAFT alike |
| 1 | the slot move's mutants caught | ≥ 85 % (E-15: 39 %; the crossing: 70 %) | below it, DEV-03 fails for every slot row |
| 2 | the whole-resource cursor at 4,096 slots | ≤ Q-19's 8 KB (E-18 reasons about 32 KB) | fall back to 1,024 slots: 72 effective writers, still above 64, with little margin |
| 4b | the `memory` rung's single-publisher p99 on `nats bench js`, one write in flight, client hop and gateway included | below JetStream's 0.55 ms by more than the larger spread (at least 0.247 ms), so about 0.30 ms, in TS or at the native step ([E-09b]) | if neither, COMP2 fails PERF-04 by measurement, as COMP, DRAFT and SPLIT would (same rung). Only a loss accepted by name then keeps a row in, and with it the arithmetic picks MIN-P+par |
| 4a | p99 commit on the real kernel at 50,000 writes/s | ≤ C + 5 ms = 5.73 ms (TS) | over it, P-01 and PERF-08 fail in TS |
| 4c | memtier SET, matched | about 92,000 persisted SETs/s at 200 connections with p99 under 4.9 ms ([E-09a2]) | below it, PERF-02 fails |
| 4d | etcd one-client put | p99 under 1.73 ms ([E-09e]) | over it in TS and native, PERF-07 fails |
| 4e | Redpanda, matched | a TS build keeps at least 62 % of E-02's protocol-free ceiling, the share Redpanda's 175,420 records/s leaves ([E-09d]) | below it in TS and native, PERF-06 fails |
| 5 | failover after a writer's crash | p99 ≤ 2.5 s in TS. At E = 2 s with 0.25 E jitter the worst draw is the timer's 2.5 s plus the few milliseconds E-13 measured to elect and to acknowledge the first write (about 5 ms, up to 20), so about 5 to 20 ms over the bar; E at about 1.98 s or less, or less jitter, keeps it under ([E-13], reasoned) | over it, F-05 fails for every Raft row alike |
| 5 | the move's unwritable window | ≤ 10 ms per move at p99 under 10,000 writes/s (three commits measured 16.7 ms, [E-13]) | if a one- or two-commit move still misses it, SC-08 fails for every slot row, unless (b) is restated |
| 5 | goodput at twice capacity | ≥ 80 % of peak (TS measured 79 to 82 %, [E-39]) | below it, F-19 fails in TS |
| sim, phase 4 | effective writers per resource with the real mover | ≥ F_w = 64 (E-18 predicts 135 at 4,096 slots) | below it, COMP2 fails SC-03 and SC-10 restated, and SPLIT, whose splits have no fixed ceiling, is the only judged row left in |

## 10. What the skeptics said

Three skeptics and a price check read the first draft. Each finding was checked against the files before acting. The scripts this revision used are in the scratchpad, `/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad/verdict-fix/` (`lib.py`, `near.py`, `sweep.py`, `far.py`, `rerule.py`, `f15.py`; a copy of `judging/` and `tools/` in `v5/`, which rebuilds `outcome.json` and `pairs.json` byte for byte). The skeptics' own scripts are in that scratchpad's `skeptic-arith/`, `skeptic/`, `skeptic-alt/` and `e41-recheck/`.

**Arithmetic and cells** (lens: OUTCOME rebuilt, counts re-derived, every number checked, COMP's differing cells read).
- **1-S1** (changes the winner). Claim: by rule 3, COMP with Z `par` beats COMP; "COMP follows rule 4" is stale. **Fixed:** checked (par-repair settled not novel, MECHANISMS 4.2; COMP+par 3 novel, 6 SHOULDs, 293 pairs). Section 0 now names COMP2, which also takes C `cent-co` (finding 3-S1); sections 3, 4, 5, 6, 8 (items 3, 25) and 9 rewritten; "COMP follows rule 4" is gone.
- **1-S2.** Claim: the "thin margin" uses SPLIT's 278 pairs, which leave out the merge its SC-04 needs. **Fixed:** checked (295 with `merge-record`; COMP keeps the lead up to a swing of 3). Sections 0, 3, 4 and 9 restated; OUTCOME B.3's two lines explained in section 3.
- **1-S3.** Claim: "forbid the wait and SPLIT wins" holds only while DRAFT's and SPLIT's mark has no home. **Fixed:** checked by recomputing each reading; section 2, section 4's table and section 8 item 11.
- **1-S4.** Claim: F-02 should be open for the `win` rows. **Fixed:** checked against the crossing README; listed below to re-rule; section 2 notes the met counts.
- **1-S5.** Claim: ten structural failures carry gaps. **Fixed:** checked (V4's 8, BUY's 2); section 2's sentence, and a table of every gap.
- **1-S6.** Claim: "every row that runs its own kernel carries 144 or more" is false for V4 (52). **Fixed:** section 7 says "every v5 row".
- **1-S7.** Claim: section 0 left out the readings and SLOG case; SC-04 is failed by LANE too. **Fixed:** section 0 line 6 names the four clause groups, F-05's SLOG case, F-15's SPLIT case and the three readings; section 2 says ISR and LANE.
- **1-S8.** Claim: the 2.5 s failover is over the bar at the worst draw, not on it. **Fixed:** section 9's row now gives about 5 to 20 ms over and the E that keeps it under (E-13: the election timer plus about 5 ms; the first write 2 to 20 ms after the election).
- **1-S9.** Claim: MECHANISMS section 2 prints stale pair counts for PD, ISR, OBJ. **Fixed:** section 1 says pairs.json is the source and names the stale three.

**The evidence under the deciding cells** (lens: the cells that put rows out, and the 1.3 restatements).
- **2-S1.** Claim: the PERF-04 failure of the 12 `persisted`-only rows rests on C as a floor, which it is not; it holds by PERF-01's spread rule. **Fixed:** checked (E-01: 481 µs one-writer p99 + 58 µs; E-09b: 0.536 to 0.783 ms; a two-of-three commit sampled from E-01's distribution comes to about 0.42 ms with the client's hop, computed here). Sections 1 and 3 restate the reason; the cells are listed to re-rule. With gap 1.41 instead of 0.33, SLOG stays 2nd in A (3.18 against 3.21, computed here).
- **2-S2.** Claim: the `memory` rung neither ties in TS nor wins in Rust by PERF-01's rule; the kill bar is about 0.30 ms. **Fixed:** sections 0, 5, 8 (item 2) and 9. Not taken: reading E-02 as a ceiling that fails COMP's PERF-04, because E-02 never ran one write in flight, so it bounds nothing for this row.
- **2-S3.** Claim: F-05's handover clause is failed on evidence that is not a ceiling. **Taken:** listed to re-rule; section 2 gives A's result with it (level DRAFT, SPLIT, ISR); section 4 and item 8 note the SLOG line goes.
- **2-S4.** Claim: F-17 as worded fails only under E-38's star reading. **Taken as a user reading,** not a re-ruling: checked in E-38's raw `sweep5`/`sweep3` results (0 of 299 and 0 of 159 clique runs stuck); section 2 and item 23.
- **2-S5.** Claim: F-15 is not a clause no row meets; the open cells clash with MECHANISMS' unit name; both choices the other way give SRV. **Fixed:** section 2 says F-15 is a clash, not a universal failure; item 11 and section 4 give SRV, SPLIT and level by reading. The F-15 cells are left open, as A-08 leaves the mark's home open; the unit's name in MECHANISMS is a name, not a ruling on its home.
- **2-S6.** Same as 1-S2. **Fixed** there.
- **2-S7.** Claim: P-05's as-worded "ceiling" is one prototype's working point. **Taken:** listed to re-rule (open as worded); section 2 states the basis. No order changes at the top beyond what 2-S3 does (computed here).

**The strongest case for a different answer** (lens: the MIN family, SPLIT, DRAFT, ISR, BUY; designs outside the space; strict readings).
- **3-S1** (changes the winner). Claim: MIN-P plus the `memory` rung (MIN-P+m) beats COMP on pairs, since leader healing earns no cell. **Fixed:** checked (COMP and MIN-P differ only on PERF-04; 264 against 283 pairs; 49 against 30 distinct control-plane pairs). With `par` (1-S1) this is COMP2, the new answer.
- **3-S2** (changes the winner). Claim: a split-and-merge composite beats COMP. **Taken in part:** the skeptic's 2-novel row drops dormant groups and project groups yet keeps COMP's SC-13 cell, which E-36 contradicts (86 KB an idle resource); with dormant groups kept, SPLIT2 has 3 novel, 6 SHOULDs and 266 pairs, and does rank above COMP2 on copied cells. Not named, because three of its cells need reasoning and its lead is 8 pairs; section 4, item 24, and the first job of section 9.
- **3-S3** (changes the winner). Claim: TiKV's shape with COMP's fixes beats COMP; rule 3 ignores open MUSTs in B too. **Taken:** section 1 states the blind spot for both outcomes; PD+fix priced (0 novel, 238 pairs, 119 open MUSTs). Not named: its DATA-01 is open only by a reading this page asks to re-rule (below); item 24.
- **3-S4.** Same as 1-S2. **Fixed** there.
- **3-S5** (changes the winner). Claim: log replicas have a precedent in TiKV's witness. **Checked at the source:** TiKV's RFC 0106 (tikv/rfcs pull request 106, commit 12bde3b, 2023-02-08) says a witness "can be elected as leader if the other voter's log is out of date", replicates the log to the lagging voter, rejects reads and writes with `IsWitness` while it leads, and transfers leadership; TiKV's protocol (pingcap/kvproto, master) has `metapb.Peer.is_witness` and `errorpb.IsWitness`. Listed below to re-judge. It flips the judged rows to SPLIT only with SPLIT's 278 pairs; with the merge counted COMP keeps them, and COMP2 keeps the win either way (computed here). The dedup window is left as a lead: its parts are cited, but no counter placed the set.
- **3-S6.** Claim: the top rests on a reads-and-writes list no second agent checked. **Fixed:** section 4 says so, and names the margins it decides (19 pairs on C, 8 against SPLIT2).
- **3-S7.** Same as 1-S1. **Fixed** there.
- **3-S8.** Claim: the PERF-01 choice only decides whether the `memory` rung is added. **Fixed:** item 2 (accepted: MIN-P+par; not: COMP2, which owes K-09 and a winning number).
- **3-S9.** Claim: the outside designs map onto rows that are out, except the TiKV, CockroachDB and FoundationDB family. **Recorded, not checked here** (the mapping is the skeptic's, from vendor docs it read): WarpStream and Bufstream map to OBJ (produce p99 under 150 ms on S3 Express, about 50 ms with Lightning Topics, against C + 5 ms); AutoMQ outsources replication to a cloud disk no SPACE option covers; Restate's Bifrost, Delos and LogDevice map to SLOG; Calvin and Fauna to R `calvin` (10 ms epochs, declared read and write sets); CRDT-first to V4 and `crdt+c`; FoundationDB to PD's family, pruned in SPACE 4.3 by reasoning and never judged. That family is what SPLIT2 and PD+fix stand for here; the judging pass of section 9 covers it.

**The price check** (lens: E-41's prices against the vendors' own sources; read 2026-11-10 from Fly's docs source, superfly/docs commit ed9082f9, and Tigris's, tigris-os-docs commit 358b7edb; the AWS hosts were not reachable from this session).
- **P-1.** Claim: Fly bills transfer to Tigris, which E-41 counts as free. **Fixed** in sections 5 (DEP-21's closer) and 6 (OBJ's line and the written reasons). E-41's own tables are not this page's to change.
- **P-2.** Claim: all 8 Fly prices and both Tigris prices match E-41. **Fixed:** DEP-21's closer in section 5 is narrowed to the region, the subscribers' place, the AWS prices and the transfer line.
- **P-3.** Claim: PD's DEP-21 is over the bar even with one app machine ($16.26 to $16.78). **Taken:** listed below to re-rule; no outcome changes (PD 17th in A either way, out in B). SRV's cell text ($9.45) is not this page's to change; with re-read prices it is $9.58 to $10.11.
- **P-4.** Claim: E-41 used the cheapest regions only. **Fixed:** section 6 and item 26.
- **P-5.** Claim: DEP-21 asks this page for a written reason for each row over 2 times the cheapest, and there was none. **Fixed:** section 6, "DEP-21's written reasons".
- **P-6.** Claim: at 5,000 writes a second the upload is the largest item and BUY becomes the cheapest. **Fixed** in section 6's reasons; the rest is E-41's.
- **P-7.** Claim: same-region traffic is free only on granular data-transfer rates. **Fixed:** section 6 and item 26.
- **P-8.** Claim: Fly bills a 730-hour month. **Not changed here:** it moves every Fly machine line by 1.4 % and no DEP-21 verdict; it is E-41's to fix.
- **P-9.** Claim: the 13 AWS prices are still unread. **Not changed:** no DEP-21 cell rests on them; section 5's DEP-21 closer keeps "the AWS prices read at the source".

**Whether the verdict survived each lens.**
- Arithmetic and cells: the arithmetic survived (OUTCOME rebuilt byte for byte here too); the answer did not, and is now COMP2.
- Evidence under the deciding cells: outcome B's winner among the judged rows survived; three failure reasons and one reading changed outcome A's top and several sensitivity lines.
- Strongest case for a different answer: COMP did not survive; COMP2 replaces it, and two farther rows stay open for the judging pass.
- Prices: survived; no winner moves, PD's DEP-21 leans to fails, and the written reasons are added.

**Cells to re-rule** (the judging files are unchanged; each effect computed here on a scratch copy).

| Cell | Settled now | Corrected | Evidence | Changes the outcome? |
|---|---|---|---|---|
| F-05 (M), as worded, the 15 Raft rows | fails (ceiling, gap 1.44) | open as worded; restated stays open | AMENDMENTS 1.3's own line ("or it stays open"); [E-13]: "met at the median ... and not at the tail", the quiet window's longest gap 4.4 to 22.9 ms, E-01's 20 to 50 ms flush stalls; etcd's Go server is no ceiling for a port | A: first place becomes level DRAFT, SPLIT, ISR (4 MUSTs, 1.77). B: no |
| P-05 (M), as worded, the 18 rows whose cell is restated | fails (ceiling, gap 0.45) | open as worded | [E-08]'s p99 is at about half a core per relay, one prototype's working point; Rust slower than Node shows the build set it | A: with F-05, level DRAFT, SPLIT, ISR (3, 1.32); alone, ISR stays first. B: no |
| PERF-04 (M), MIN, RUST, SRV, LEAN, LANE, PD, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE | fails (ceiling, "C is the floor", gap 0.33) | fails, on PERF-01's spread rule (a win needs below about 0.30 ms; a persisted commit at two of three plus a hop is about 0.42 ms at best), basis reasoned from measured parts; gap about 0.39 against the best case, 1.41 against C | [E-09b] (0.550, runs 0.536 to 0.783 ms), [E-01] (481 µs, 58 µs) | no: with 1.41, SLOG 3.18 against DRAFT 3.21 in A |
| F-02 (M), DRAFT, LANE, SPLIT | met | open | [crossing/README.md]: a write both applied and refused at E-20's floor against E-17's lock-token refusal; the `win` rows "not checked here, and owed the same floor rule by reasoning" | no; met counts fall by 1 |
| DEP-21 (M), PD, both readings | open | fails (structural: its shape's machines) | the price check: $18.48 to $19.01 as E-41 shapes it, $16.26 to $16.78 with one app machine, at prices read from Fly's docs source | no: PD stays 17th in A and out in B |
| DATA-01 (M), PD | open | fails (structural) | both judges' own words, "data is not the engine on PD's servers", and SPACE 4.2's PD row; DATA-01 asks that data's lane fold the rows on writers and followers, which a differential test cannot show | no for the judged rows (PD is out); it puts PD+fix out |
| `merge-record` (mechanisms.json), its rows | PD | PD and SPLIT | the referee's SC-04 ruling for SPLIT; SPACE section 2 (`split` "and later merges"); AMENDMENTS section 3 (37 rules, both protocols) | B, judged rows: COMP either way; SPLIT 295 pairs; OUTCOME B.3's two flips to SPLIT go |
| `log-replicas` (mechanisms.json), novel | true | false (precedent: TiKV's witness) | TiKV RFC 0106 and kvproto's `is_witness` and `IsWitness`, read at the source here | B: SPLIT wins the judged rows only if `merge-record` is not added; COMP2 wins with the neighbours either way |

With all the corrections above taken together, outcome A's first place is level: DRAFT, SPLIT and ISR (3 MUSTs, 1.32); outcome B among the judged rows is COMP; outcome B with COMP's neighbours is COMP2 (computed here).

[pairs.md]: experiments/E32-composition/pairs.md
[crossing/README.md]: experiments/E32-composition/crossing/README.md
[E-01]: experiments/E01-floors/README.md
[E-02]: experiments/E02-pipeline/README.md
[E-08]: experiments/E08-relay-fanout/README.md
[E-09a2]: experiments/E09a2-redis-memtier/README.md
[E-09b]: experiments/E09b-nats/README.md
[E-09c]: experiments/E09c-kafka/README.md
[E-09d]: experiments/E09d-redpanda/README.md
[E-09e]: experiments/E09e-etcd/README.md
[E-13]: experiments/E13-handover/README.md
[E-14b]: experiments/E14b-membership-liveness/README.md
[E-14c]: experiments/E14c-membership-completion/README.md
[E-16]: experiments/E16-controller-loop/README.md
[E-17]: experiments/E17-partitioning/README.md
[E-17c]: experiments/E17c-partitioning-rerun/README.md
[E-18]: experiments/E18-slot-balance/README.md
[E-21]: experiments/E21-time/README.md
[E-22]: experiments/E22-api-prototype/README.md
[E-22b]: experiments/E22b-real-elle/README.md
[E-28]: experiments/E28-minio-log/README.md
[E-31]: experiments/E31-subscribe/README.md
[E-33]: experiments/E33-genesis-restore/README.md
[E-35]: experiments/E35-neighbours/README.md
[E-36]: experiments/E36-many-resources/README.md
[E-37]: experiments/E37-bad-entry/README.md
[E-38]: experiments/E38-raft-gray-failures/README.md
[E-39]: experiments/E39-overload-storm/README.md
[E-41]: experiments/E41-hosted-cost/README.md
[E-44]: experiments/E44-outside-log/README.md
[E-45]: experiments/E45-drivers/README.md
