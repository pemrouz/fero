# The v5 verdict

Draft 3, written 2026-11-11 for the v5 design-space study ([BRIEF.md](BRIEF.md)), and revised the same day after four skeptics tried to refute it (section 11). Draft 2 (2026-11-10) named COMP2 but called itself "not final", because rows nobody had judged could rank above it. Since then a **closure pass** has searched the space between the judged rows and judged the best of them blind ([judging/closure/README.md](judging/closure/README.md)). This draft reads that work.

Every number here comes from a file or a tool, and the text says which. "Computed here" means a scratch script that only calls the study's own code (`tools/closure.py`'s cell model, tally and pair rule, and `tools/judging.py`'s rule 3); section 10 names each script. No judging file was changed.

## 0. The answer

1. **Build COMP2, if the user reads DATA-01 strictly, as this page recommends.** On the cells as the judges settled them, which follow the loose reading of DATA-01 (the reading in force), the judging rule names TiKV's shape (TiKV-TS) instead. DATA-01 is the one place where this page departs from a reading in force; section 3.3 says why. COMP2 in plain words: Raft groups owned by the project hold fixed slots of many resources; one loop on `#meta`'s leader heals replicas and moves slots; a write commits `persisted` by default (`memory` or `none` per resource); a damaged log entry is repaired from a peer; `data` folds the rows in every app process; TypeScript first, a Rust core later.
2. **Where it wins:** with the AMENDMENTS 1.3 clauses restated, no competitor default accepted as a loss, and DATA-01 read strictly (on writers and followers, only `data`'s own code folds rows). Score: 3 novel mechanisms, 6 SHOULDs met, 277 interacting pairs, no MUST failed, 98 open ([matrix.md](judging/closure/results/matrix.md)). Rule 3 cannot separate it from twins that tie it on its three counts: COMP2 V=full, variants on H and U, and (with one guessed cell) COMP2 in TypeScript for good. This page keeps AMENDMENTS 4's picks (section 5.1). **On the strict reading COMP2 needs one pin** (a design rule the row must keep, which no judge has ruled): its Rust core, when it comes, orders, stores and ships records but never folds rows, and `data` keeps folding every row in JavaScript on every full replica (REQUIREMENTS X3's first way). Without the pin, COMP2's native step has SRV's shape, which the strict reading fails (section 3.3).
3. **User choice 1, DATA-01.** If a server may fold rows in another engine once a differential test proves the result equals data's (DATA-09's path, the judges' reading, in force now), TiKV's shape wins on 0 novel mechanisms (TiKV-TS: 4 SHOULDs, 244 pairs) with 122 MUSTs open, 24 more than COMP2, because no experiment ran that shape. BRIEF item 6 ("`data` stays the state engine") supports the strict reading (section 3.3). Even on the loose reading, grounds that rule 3 never counts favour COMP2: 34 MUSTs met against 10; a build sized at about 8,000 lines against no estimate for two-phase commit, a timestamp oracle and a multi-version store; fero's methods kept on servers; a lower hosting bill; and data records that need no new format inside two-phase commit (section 3.3). The choice is the user's.
4. **User choice 2, PERF-01.** If the user accepts JetStream's default row as a loss by name, the `memory` rung goes: MIN-P+par (COMP2 without that rung) wins, or TiKV-persisted on the loose reading. As worded, every row fails a MUST. The other choices that can move the winner are bold in section 8, among them F_w above 135 (SPLIT on the strict reading) and F-15 kept as worded.
5. **How sure.** Settled among the options some judged row holds: the search built about 379,000 mixes, and on the strict reading none with 3 or fewer guessed cells (cells no judged row backs) beats COMP2, also in a further shell of about 21,500 mixes around the 11 rows the closure pass judged blind (section 4). Four options no judged row holds could still beat it on predicted prices; each needs an experiment and a judging pass first (section 4.7). On the loose reading, once one guessed cell is allowed, rule 3 goes round in a circle (A beats B, B beats C, C beats A) and names no row (section 4.4). Thin against its judged neighbours: its lead is one SHOULD (F-22 S) over COMP and MIN-P+m, and 5 pairs over a twin with a separate controller, a lead that rests on one ruling of family A (section 7.5). Three things it rests on were never modelled (section 7).
6. **Next step: no more judging among the options judged rows hold, on this reading.** Model what COMP2 rests on (`par` with a voter change, the controller healing while it moves slots), then build a thin TypeScript slice without the `memory` rung (MIN-P+par's shape), break it under chaos and time it with each rival's own tool. The `memory` rung joins only after a timing spike passes the first kill test: with one write in flight, a p99 under about 0.30 ms and at least about 4,340 acks a second, since JetStream's default gets p99 0.55 ms and 3,280 a second ([E-09b]; RR-04; PERF-01's spread rule). Only then is the rung modelled inside Raft (section 9).

## 1. The question and the rule

**What was compared.** A **row** is one whole design: one option on each of 22 **axes**, the design questions of [SPACE.md](SPACE.md) section 2 (for example R, how replicas agree, or Q, what a commit means). 31 rows are judged. Twenty come from the first judging: nineteen of SPACE's named designs as AMENDMENTS sections 1 and 3 fixed them, and **COMP**, the composite that takes AMENDMENTS' favoured option on each axis. Eleven more were judged by the closure pass (section 4), on the 72 cells no judged row supported, the crossings the judges raised and each row's mechanism list; their other 1,556 cells are predictions from the judged rows (section 4.2). All were judged against the 140 requirements of [REQUIREMENTS.md](REQUIREMENTS.md): 148 parts, 132 of them MUST and 16 SHOULD. A **cell** is one requirement part for one row: 148 × 31 = 4,588 cells.

**Words used below.**
- A MUST is **met**, **open** (not shown either way) or **fails**. A SHOULD is met, not met, or open.
- A **mechanism** is one named piece of durable or replicated state plus the rules that write it. It is **novel** when no paper or production system has the same state and rules in the same role (DEV-10). DEV-01 counts novel mechanisms per row.
- An **interacting pair** is two mechanisms of one row that touch one piece of state, at least one writing it. DEV-02 counts them. The counts come from code ([judging/PAIRS.md](judging/PAIRS.md), `tools/closure.py`).
- **C** is the study's commit bar: the three-writer fsync p99 plus the round-trip p99, 0.73 ms on this box ([E-01]). It is a sum of two p99s, not a floor.
- A **rung** is what a commit means: `persisted` (on disk at a majority), `memory` (in memory at a majority), `none` (best effort).
- A **group** is one Raft log with one leader. A **slot** is a fixed share of a resource's keys; a **slot move** takes a slot from one group to another.
- **A-nn** is a fix of AMENDMENTS section 1; **K-nn** a crossing of AMENDMENTS section 4 (mechanisms no experiment ran together); **G-nn** a gap of AMENDMENTS section 5.
- **RR-nn, RM-nn, RF-nn** are re-rulings a referee made after draft 2: RR a cell ([rerulings.cells.json](judging/closure/rerulings.cells.json)), RM a mechanism's count, RF a mechanism's record of reads, writes or wording ([rerulings.mech.json](judging/closure/rerulings.mech.json)). Both tools apply them.
- The **closure pass** words: the **attribution** says, for each requirement part, which axes decide its cell; a predicted cell is **supported** when a judged row shares its options on every deciding axis, and **guessed** (the files say "unsupported") when none does; a **ladder** ranks rows as more guessed cells are allowed; the **matrix** gives the winner under each mix of the user's open choices.
- **DATA-01, loose and strict.** DATA-01 says data's hot lane folds the rows "the same on writers, followers, clients and replays". The **loose** reading (the judges', in force) lets a server fold rows in another engine once a differential test proves the result equals data's (DATA-09's path). The **strict** reading, as the referee framed it (RR-10), says only data's own code folds rows on writers and followers, so a native fold fails: SRV fails with PD. The tool encodes it by two rules only, for servers that fold in Rust or Go (F `all(srv)`) and for PD's engine (K `kern` with an LSM). A **middle** reading (data's lane, or a port of it proven by DATA-09's test; no other engine) fails PD's family only and gives the same winners as the strict one (section 3.3).
- A **cycle** is when rule 3 goes round in a circle: A beats B, B beats C and C beats A, so no row beats all the others. It can happen because two rows tie on the novel count whenever they are fewer than 2 apart (section 4.4).

**The judging rule** (REQUIREMENTS, "Judging rule"), in plain words:
1. A row **fails** a MUST only on proof: a counterexample in a model of its own mechanism, a measured ceiling below the bar, or a structural argument that a second agent confirms in writing. Otherwise the MUST is **open**.
2. A row that fails a MUST is **out**. If every row is out, rank them by how many MUSTs each fails, then by the sum of gap ÷ bar over those MUSTs.
3. Among the rows still in: if two rows' counts of novel mechanisms differ by 2 or more, the lower count wins. Otherwise the row that meets more SHOULDs wins. If still level, fewer interacting pairs wins.
4. (For the user to confirm.) Rule 3 ranks few novel mechanisms above the SHOULD count.

**What the rule does not look at.** Rules 2 and 3 never count open MUSTs, and never count rules. So a row with less evidence can rank above a row with more. This decides more than one line below.

**Why two outcomes.** AMENDMENTS section 1.3 lists clauses that the evidence shows no row meets as worded, and what each experiment asks instead. The wording is the user's, so 169 cells of the 20 study rows carry two verdicts ([OUTCOME.md](judging/OUTCOME.md)). **Outcome A** uses the requirements as written. **Outcome B** uses the clauses restated as section 1.3 asks.

**How the cells were judged.** The requirements were split into seven groups. Two judges scored each group without seeing each other's work. A referee ruled in writing on every one of the 330 cells where they differed (73 of them decisive), and never against both. Code did the arithmetic. Two blind counters counted the mechanisms, and a referee settled their differences ([MECHANISMS.md](MECHANISMS.md)). After draft 2, a referee re-ruled 54 cells and part of the mechanism list (section 7.2). The closure pass then had 72 more cells scored by two more blind judges per family and a referee (section 4.5).

**The user's numbers in force.** Until the user answers, REQUIREMENTS' proposed values apply: F_w = 64 writers per resource; N_res = 100,000 resources per project; no competitor-default loss accepted; a group's voters in one region; a tier shared between projects allowed (J changes); every latency bar also stated against a cited fsync figure; rule 3 in the order written. **Writes homed in several regions are out of scope for v5** (SC-14 asks this page to say so). DEP-21's free bar is judged for a sleeping project (RR-09). The settled cells follow the judges' loose reading of DATA-01 (RR-07); the referee named the strict reading as the user's choice (RR-10). This page gives the winner under both and names COMP2 on the strict one. That is the one place where this page departs from a reading in force: by the cells as they stand, rule 3 names TiKV-TS (section 3.3 says why the page leans the other way).

## 2. Outcome A: the requirements as worded

**The result.** Every row fails at least one MUST, so rule 2 ranks them. Among the 20 study rows, DRAFT, SPLIT and ISR are level first ([OUTCOME.md](judging/OUTCOME.md) A.2).

The MUSTs named: F-17 Partial partitions; SC-03 Scale writes up; SC-04 Scale down; SC-10 Only stated ceilings, each above its floor; F-15 Outside services; PERF-04 NATS JetStream; DATA-01 data is the state engine.

| Place | Row | MUSTs failed | Gap ÷ bar, summed |
|---|---|---|---|
| 1 | DRAFT | F-17, SC-03, SC-10 | 1.32 |
| 1 | SPLIT | F-17, SC-03, SC-10 | 1.32 |
| 1 | ISR | SC-03, SC-04, SC-10 | 1.32 |
| 4 | COMP | F-15, F-17, SC-03, SC-10 | 1.32 |
| 5 | SRV, SLOG, RLOG, EMB-V8 | 4 each | 1.71 |
| 9 | MIN, RUST, LEAN, LANE, MIN-P, MIN-TS, SIDE | 5 each | 1.71 |
| 16 to 20 | CELL (6), PD (6), OBJ (9), BUY (27), V4 (50) | in brackets | 1.54, 1.71, 18.08, 8.79, 10.04 |

**The closure rows as worded** (computed here, `standings.py`). COMP2, COMP2 V=full, MIN-P+m and COMP+par C=cent V=full fail what COMP fails (4, 1.32). The three MIN-P+par rows fail those and PERF-04 (5, 1.71). SRV V=full Y=fwd and TiKV-persisted fail 4 (1.71). PD+fix and TiKV-TS fail F-17, SC-03 and SC-10 (3, 1.32), so on the loose DATA-01 reading they share first place; on the strict reading they also fail DATA-01 (4). The matrix's as-worded lines say the same.

**Unjudged mixes as worded.** The closure pass ranks outcome B only. As worded, a search of 109,952 mixes (the tool's search plus a shell around the 11 closure rows; computed here, `worded.py`) finds 16 on the loose reading, and 13 on the strict, that fail only SC-03 and SC-10: one MUST fewer than any judged row. Every one of them carries 8 to 21 guessed cells, among them P-01 and P-02; most are ISR with another partition map. So outcome A's first places are not closed against unjudged mixes. Outcome A names nothing to build either way.

**What changed since draft 2.** Three re-rulings took two failures off every Raft row. RR-01: F-05's handover clause as worded is open, not failed, because E-13 measured etcd's own server on this disk, which is no ceiling for a port. RR-02 and RR-03: P-05's delivery bar as worded is open, because E-08's p99 was one prototype's working point at about half a core, not a floor. So first place went from ISR alone to three rows level.

**What it means.**
- **Rule 2 counts only failures that are proven.** A MUST nobody tested stays open and costs nothing. ISR is level first with DRAFT and SPLIT because its F-17 was never run: E-38 ran etcd's Raft, not ISR, SLOG, OBJ or V4 ([ISR scorecard](judging/rows/ISR.md)). So, as worded, the order mostly shows how much of each row was tested.
- **SC-04 is failed by ISR and LANE only.** ISR's partition count is fixed when a resource is made and nothing merges a group; LANE has no rule that removes a lane (structural). ISR still fails SC-03, SC-04 and SC-10 in outcome B.
- **With F-17 read the clique way** (section 8, item 19), the Raft rows' F-17 is open as worded, and DRAFT and SPLIT lead with 2 MUSTs (with PD+fix and TiKV-TS on the loose reading; computed here, `clique.py`).

**Every gap ÷ bar in the settled cells, as worded** (rule 2 asks this page to write each one down; computed here over the 31 rows, `gaps.py`; "proof" from the cells):

| Requirement | Gap ÷ bar | Proof | Restated | Rows |
|---|---|---|---|---|
| SC-03 and SC-10 | 0.66 | ceiling | open | the 15 study rows DRAFT, MIN, RUST, SRV, LEAN, SPLIT, PD, SLOG, OBJ, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP, and all 11 closure rows |
| SC-03 and SC-10 | 0.66 | ceiling | fails | LANE, ISR, V4 |
| SC-03 and SC-10 | 0.77 / 0.98 | ceiling / structural | fails | CELL / BUY |
| PERF-04 | 0.39 as recorded; 0.06 to 0.39 by how the round trip is counted | ceiling, reasoned from measured parts (RR-04) | fails (open if the loss is accepted) | MIN, RUST, SRV, LEAN, LANE, PD, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, the three MIN-P+par rows, SRV V=full Y=fwd, TiKV-persisted |
| PERF-04 | 0.43 / 0.93 | ceiling / structural | fails | OBJ / V4 |
| P-05 | 2.2 / 0.91 | ceiling | fails | OBJ / V4 |
| PERF-02, PERF-05, PERF-06, PERF-07 | 0.96, 0.96, 0.98, 0.84 | ceiling | fails | BUY |
| PERF-02, PERF-03, PERF-05, PERF-06, PERF-07, PERF-11 | 0.997, 0.996, 0.997, 0.999, 0.99, 0.91 | structural | fails | V4 |
| PERF-07, PERF-08 | 0.38, 1.17 | ceiling | fails (PERF-08 depends on its phase reading) | OBJ |
| DEP-12 | 0.93 / 0.995 | ceiling / structural | fails | BUY / V4 |
| F-05, F-19 | 1.08 each | ceiling | fails | BUY |
| DEP-21 | 12.58 | ceiling | fails | OBJ |

A failure proven by a counterexample carries no gap, and neither do most structural ones. F-17 (26 Raft rows) and F-15 (15 rows, and OBJ in both readings) fail as worded with no gap.

**PERF-04's gap is a range.** RR-04's 0.39 adds the round trip's p99 (58 µs) as a constant to each follower's fsync and again for the client's hop. A p99 used as a constant is not a lower bound. Sampled from E-01's fsync table with the median round trip (30.6 µs), the best `persisted` commit has p99 0.343 ms, or 0.373 ms with the hop: gap 0.23. With no network cost at all, the second-fastest of three fsyncs has p99 about 0.32 ms: gap about 0.06 (computed here, `rr04.py`, 0.323 ms; the evidence skeptic's sample gave 0.3215 ms). Every figure is above the 0.303 ms bar, so the failure stands in every case. The gap sums of the PERF-04 rows fall from 1.71 to between 1.38 and 1.55. No place above 16 moves; at places 16 and 17, PD (6 MUSTs) passes CELL (6, 1.54) when the gap is below about 0.22.

**The clauses rows fail as worded** (AMENDMENTS 1.3; cells in the `settled.json` files and the closure cards):

| Clause | Rows that fail it as worded | Why | What the evidence asks |
|---|---|---|---|
| SC-03 (Scale writes up) and SC-10: at least F_w = 64 effective writers per resource | all 31 | under Zipf 0.99 the hottest partition holds 5.5 to 9.8 % of the load and nothing splits a partition, so every design reaches only 12 to 22 effective writers ([E-18], simulated) | "with every partition above half a writer's share split by the app": then 72 at 1,024 slots, 135 at 4,096 |
| F-17 (Partial partitions) | the 15 Raft study rows and the 11 closure rows | 5 of 280 five-node partial partitions with the leader up stayed stuck with a "connected majority" read as E-38 reads it, a star (one server with two-way links to a majority), by Raft's own vote rule ([E-38], simulated on etcd's Raft). None of the 5 has a clique (a majority whose every pair talks both ways). Like for like, with the leader up, 0 of 188 five-node and 0 of 111 three-node clique runs got stuck (RR-08; 299 and 159 if leader-crash runs are counted) | "a connected majority that includes an up-to-date replica", or a new election rule (+1 novel mechanism), or the clique reading (item 19) |
| F-15 (Outside services) | the 8 slot study rows whose restore mark lives in the object store (MIN, RUST, LEAN, SLOG, MIN-P, MIN-TS, SIDE, COMP) and the 7 closure rows built on them (COMP2 and its family) | a slot move records its new epoch in the store before use ([E-33]'s rule), so a move waits while the store is down; F-15 lets only wake, new replicas and old history wait (structural) | F-15's list adds slot moves, or the mark gets another home |
| P-05 (WebSocket fan-out by room) | OBJ and V4 only, on their own reasons | as worded the others are open (RR-02, RR-03): C + one hop is about 0.83 ms here, and E-08's relay measured 1.2 ms (Node) and 3.5 ms (Rust) at about half a core, one working point ([E-08]) | a coalescing window per room and about 1,000 sockets a core |
| F-05's handover clause | none now (RR-01) | etcd's handover paused its group 9.7 to 9.8 ms at the median and 24 to 31 ms at worst on this disk, mostly the disk's own stalls ([E-13]) | "C plus the box's normal longest gap between commits plus 5 ms" |

F-15 is not a clause no row meets. It is a clash between the store-held restore mark and F-15's list. DRAFT, SRV, RLOG and EMB-V8 move slots too, but they found a cluster by `fero init`, and A-08 leaves the home of their mark open, so their F-15 is open. The TiKV-shaped rows keep F-15 open because writes, elections and new replicas use the local store, not the object store (family B's judges). The other lines of 1.3 (SC-08 (b), SC-13's "small", SC-05 at 10 GB, F-10's untested clauses, DEP-21's $10) leave the leading rows' cells open either way.

## 3. Outcome B: the clauses restated

### 3.1 The 20 study rows

Rows still in (no MUST failed): DRAFT, SPLIT, COMP. COMP beats both ([OUTCOME.md](judging/OUTCOME.md) B.2):

| Pair | Novel mechanisms | SHOULDs met | Interacting pairs | What decides | Winner |
|---|---|---|---|---|---|
| COMP against SPLIT | 3 against 4 | 5 against 5 | 283 against 295 | 1 apart, SHOULDs level, fewer pairs | COMP |
| COMP against DRAFT | 3 against 5 | 5 against 5 | 283 against 309 | 2 apart | COMP |
| SPLIT against DRAFT | 4 against 5 | 5 against 5 | 295 against 309 | 1 apart, SHOULDs level, fewer pairs | SPLIT |

The three meet the same five SHOULDs: DEV-04 (Published core), DEV-05 (Small code), OPS-11 (Debugging in production), P-22 (Delayed jobs, waiting takes, priorities) and SC-12 (Clients). Two mechanism re-rulings set SPLIT's numbers: it now carries the merge its SC-04 relies on (RM-01: 278 to 295 pairs), and log replicas are not novel, because TiKV's witness has the same state, rules and role (RM-02: SPLIT 5 to 4, DRAFT 6 to 5).

Ten study rows fail only PERF-04 (NATS JetStream): MIN, RUST, SRV, LEAN, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE. Their only durable rung is `persisted`. PERF-01 counts a win only when fero beats JetStream by more than the larger spread. JetStream's default acks one publisher at p99 0.550 ms over runs of 0.536 to 0.783 ms ([E-09b]), so a win needs a p99 below about 0.30 ms. The best a `persisted` commit can do here is the second-fastest of three fsyncs plus a round trip, sampled from E-01's one-writer fsync table: p99 0.364 ms, and 0.422 ms with the client's hop, before any CPU cost, if the round trip's p99 is added as a constant. Three agents computed this, and RR-04 rules on it: the failure stands, with gap 0.39. With the median round trip the bound is 0.373 ms (gap 0.23), and with no network cost 0.32 ms (gap 0.06); the failure holds in every case (section 2). Let back in alone, each of the ten wins among the 20 except SLOG (OUTCOME B.4).

### 3.2 All 31 judged rows: the matrix

`python3 tools/closure_matrix.py` (run for this draft; [matrix.md](judging/closure/results/matrix.md) is current):

| Reading | PERF-01: JetStream's default row accepted as a loss | DATA-01 strict | Rule 3 as written | Rule 3, open MUSTs first |
|---|---|---|---|---|
| restated | no | no | **TiKV-TS** (0 novel, 4 SHOULDs, 244 pairs, 122 open) | COMP2 and COMP2 V=full (3, 6, 277, 98) |
| restated | no | yes | **COMP2** and COMP2 V=full (3, 6, 277, 98) | COMP2 and COMP2 V=full |
| restated | yes | no | **TiKV-persisted** (0, 5, 233, 121) | MIN-TS (4, 5, 253, 95) |
| restated | yes | yes | **MIN-P+par** and MIN-P+par V=full (3, 6, 264, 97) | MIN-TS (4, 5, 253, 95) |
| as worded | no | no | all out; rule 2: DRAFT, SPLIT, ISR, PD+fix, TiKV-TS | the same |
| as worded | no | yes | all out; rule 2: DRAFT, SPLIT, ISR | the same |
| as worded | yes | no | all out; rule 2: DRAFT, SRV, SPLIT, ISR, SLOG, RLOG, EMB-V8, SRV V=full Y=fwd, PD+fix, TiKV-TS, TiKV-persisted | the same |
| as worded | yes | yes | all out; rule 2: DRAFT, SPLIT, ISR, SLOG, RLOG, EMB-V8 | the same |

"Open MUSTs first" is not the rule as written. It ranks only the rows with the fewest open MUSTs, then applies rule 3, to show what rule 3's blind spot decides.

**Why each line comes out as it does.**
- **Restated, strict, no loss: COMP2.** The TiKV-shaped rows, SRV and PD fail DATA-01 by structure (RR-10). Among the 7 rows left in, COMP2 has the fewest novel mechanisms (3, level with COMP, MIN-P+m and COMP+par C=cent V=full) and, with COMP+par C=cent V=full, the most SHOULDs (6). That twin loses on pairs (282 against 277: its controller sessions); COMP2 V=full ties COMP2 on every count. Checked pair by pair, every line of the matrix has a row no other row beats (computed here, `matrix_pw.py`).
- **Restated, loose, no loss: TiKV-TS.** It has 0 novel mechanisms against COMP2's 3, so rule 3 stops at the first step. It has 24 more open MUSTs (122 against 98). No judged row supported 15 of its cells, because none had its shape; the closure judges settled those and 4 more on crossings ([cards.json](judging/closure/hybrids/cards.json)). Its native twin (PD+fix with forwarding, `kw` threads and `par`, a Rust server) ties it on every count with no guessed cell. TiKV-TS's DATA-01 cell borrows PD's reason for a native fold, though in its TypeScript phase its servers' engine is neither data nor native code; a referee should rule it (section 11). If it fails, the loose leader is that native twin, with the same score.
- **Loss accepted, loose: TiKV-persisted.** It comes back in, since its only failure was PERF-04. Against TiKV-TS: 0 against 0, and 5 SHOULDs against 4, because without the `memory` rung its P-15 (S) holds (family B's referee).
- **Loss accepted, strict: MIN-P+par.** The `memory` rung then buys no cell and costs one: P-15 (M) is met without it and open with it (RR-11). Dropping it also saves 13 pairs (264 against 277).
- **Open MUSTs first.** Over the 31 judged rows, without the loss, COMP2 ties COMP and MIN-P+m for the fewest open MUSTs among the rows in (98) on both readings, and beats them on SHOULDs. With the loss, MIN-TS comes back in with 95. Over the searched mixes the same rule picks COMP2 in TypeScript for good (L `ts`: 3, 6, 277, 96 open, one guessed cell), which meets DATA-09 and TEST-10 because it never has a second kernel (section 5.1).
- **As worded.** Every row fails at least SC-03, SC-10 and, for the Raft rows, F-17. The rows level first are those whose only failures are those (plus ISR's SC-04). The strict reading adds DATA-01 to the TiKV-shaped rows; the loss takes PERF-04 off the `persisted`-only rows.

**COMP2 against its neighbours** (rule 3, pair by pair; computed here, `standings.py`):

| Pair | Novel | SHOULDs met | Pairs | What decides | Winner |
|---|---|---|---|---|---|
| COMP2 against COMP | 3 against 3 | 6 against 5 | 277 against 283 | F-22 (S) | COMP2 |
| COMP2 against COMP2 V=full | 3 against 3 | 6 against 6 | 277 against 277 | nothing: they tie on every cell and unit | level |
| COMP2 against MIN-P+m | 3 against 3 | 6 against 5 | 277 against 264 | F-22 (S) | COMP2 |
| COMP2 against COMP+par C=cent V=full | 3 against 3 | 6 against 6 | 277 against 282 | fewer pairs (the twin's controller sessions; section 7.5) | COMP2 |
| COMP2 against SPLIT | 3 against 4 | 6 against 5 | 277 against 295 | one more SHOULD | COMP2 |
| COMP2 against DRAFT | 3 against 5 | 6 against 5 | 277 against 309 | 2 apart | COMP2 |
| COMP2 against TiKV-TS | 3 against 0 | 6 against 4 | 277 against 244 | strict: TiKV-TS is out (DATA-01); loose: 3 apart | COMP2 (strict); TiKV-TS (loose) |

**What lifts COMP2 over COMP.**
- **Z `par`.** A damaged entry is repaired from a peer (PAR, Alagappan et al., FAST'18). `par-repair` stays not novel (RM-03), so it adds no novel mechanism, and it meets one more SHOULD: with one bad entry on each of two replicas, every one of 276 judged states reaches a working leader ([E-37], model-checked). Family A's two judges scored F-22 (M and S) met for COMP2.
- **C `cent-co`.** The judges gave leader healing (COMP) and the controller loop (MIN-P) the same verdict on every cell they share, so leader healing earns no cell. By the pair rule the controller form has fewer pairs: COMP with `par` (leaders heal) has 296, COMP2 277 (`python3 tools/closure.py mechrow`). Of those 19 pairs, 16 come from planner hints, which COMP carries as a unit and COMP2 takes as inputs to its controller (RM-04 kept it so); with hints counted on COMP2 too, the margin is 3 (computed here, `hints.py`).

### 3.3 Which DATA-01 reading the brief supports

This is the choice that decides between COMP2 and TiKV's shape. The files do not settle it, and the referee left it to the user (RR-07, RR-10).

- **What the two requirements say.** DATA-01: "Rows are folded by data's hot lane in log order, the same on writers, followers, clients and replays." DATA-09: "If any layer moves to native code, the fold's results stay data's, proven by a differential test against data."
- **The loose reading** (the judges' and AMENDMENTS A-30's, in force): a server may fold in another engine if a differential test proves its rows equal data's fold. Read so, PD's shape is open on DATA-01, and RR-07 found no step that shows its rows cannot equal data's.
- **The strict reading,** as the referee framed it (RR-10 and its user choice): only data's own code folds on writers and followers. Read so, SRV fails (its servers fold in Rust or Go) and so do PD, PD+fix, TiKV-TS and TiKV-persisted. The tool encodes this by two rules (F `all(srv)`; K `kern` with an LSM) and looks at no other axis, so its encoding is narrower than its words (section 11's re-rule list).
- **A middle reading:** data's lane, or a port of data's lane proven by DATA-09's test, folds the rows; no other engine does. REQUIREMENTS X3 offers exactly these two ways out of the clash between data (JavaScript) and a native kernel: "data folds on the JS side; or port data's apply lane with differential tests". Read so, SRV and its twin pass DATA-01 and PD's family still fails it. Every matrix line keeps its winner: SRV is out on PERF-04 without the loss, and with it SRV loses to MIN-P+par (4 novel and 5 SHOULDs against 3 and 6; computed here, `middle.py`).
- **Why the brief leans strict, or middle.** BRIEF item 6 says "`data` stays the state engine", and its change records are fero's wire format. In TiKV's shape the servers' engine is a multi-version store in an LSM under two-phase commit; data folds only on clients. Both PD judges wrote "data is not the engine on PD's servers" (RR-07), and SPACE's own PD line says the same ("`data` is not the engine on servers", G6). SPACE also marks a Rust or Go server as a risk to G6 (SRV's row: servers "cannot run methods, rules or `data` views without embedding JS"; its note on L `rs-srv`: "`data` folds on clients only"), which backs the referee's strict framing; X3 backs the middle one. A test can prove two engines give equal rows; it does not make a different engine data.
- **What the strict reading asks of COMP2.** Read word for word, it binds COMP2 too. (1) DESIGN-V5 puts "records → rows" in the layers that move to Rust, and the native step's closer for DATA-09 is a differential test of a native fold. On the strict reading the Rust core must never fold: records cross to data in JavaScript (X3's first way, E-03), and DATA-09 then holds by construction (the attribution's own words for that branch). (2) In TypeScript, decision 13's kernel worker keeps its own compact copy of the rows to judge writes (E-05, A-27), and DESIGN-V5's main thread holds only the rows it reads or serves. On the strict reading every full replica keeps a full data projection (E-05's `projection all`: 510 to 528 B a row with both copies), and the worker's copy is a cache of data's rows, checked against them by F-21's hash, not a second engine (reasoned here; no referee has ruled it). With this pin COMP2 passes the strict reading. Without it, COMP2's native step has SRV's shape and fails as SRV does. On the middle reading the pin is not needed: a port proven by DATA-09 is allowed.
- **What the loose reading has for it.** DATA-09's words do say "any layer". The judges read it that way, and the user may prefer a shape with no novel mechanism even at the cost of the brief's sixth aim. On aim 4's own two counts, TiKV-TS beats COMP2: 0 novel against 3, and 244 pairs against 277.
- **Grounds rule 3 never counts, on the loose reading.** Even where the rule names TiKV-TS, these favour COMP2. None is a judged order; each is a fact from the files. (1) Evidence: COMP2 has 34 MUSTs met against TiKV-TS's 10, because no experiment ran TiKV's shape. (2) Build size: E-44 estimates about 8,000 fero-owned lines for a Raft-per-group row and gives none for two-phase commit, a timestamp oracle and a multi-version store. Its one figure covers 11 rows, so it cannot separate COMP2 from its neighbours. (3) API: TiKV-TS's U `cli` runs no user code on servers, so fero's methods become declarative rules or WASM (SPACE 2, U). (4) Cost at 10 writes a second on Fly: COMP2's shape $7.52 to $7.89; PD's $18.64 to $19.01, or $9.58 to $10.11 with the placement process inside the stores (section 6). (5) The data seam: DATA-03 needs a data record to ride inside a two-phase-commit prewrite, a format nobody designed. One caveat on TiKV's 0: family B left open how its timestamp oracle restarts after an unclean loss of the controller's majority (OPS-07). A store-held window there is the restore mark's kind of rule, which is novel; TiKV's shape would then have 1 novel, still 2 below COMP2, so no order moves (reasoned).

## 4. Could an unjudged mix beat it? The closure pass

### 4.1 Why it was needed

The 20 study rows are 20 points in a space of 22 axes. Draft 2 priced six rows between those points by hand, and two of them (SPLIT2 and PD+fix) ranked above COMP2 on copied cells. A hand search never ends: the next reader can always try one more mix. So the closure pass let code build every mix near the judged rows, judge them by the same rule, and send the best to blind judges ([judging/closure/README.md](judging/closure/README.md)).

### 4.2 Step 1: the attribution reproduces every judged row

For each requirement part, [attrib/](judging/closure/attrib) names the axes that decide its cell and gives the verdict for each option, read from the judges' own reasons. [mechanisms.json](judging/closure/mechanisms.json) gives each mechanism the options that carry it, and [constraints.json](judging/closure/constraints.json) the options that force or forbid others. Where a cell follows something no axis expresses, it is an **override**: that row keeps its own cell, and no other row may borrow it.

`python3 tools/closure.py check-all`, run for this draft: all 4,588 cells of the 31 rows reproduced, with 0 mismatches and 29 overrides (all of them V4's); 112 mechanism entries, 0 mismatches; 54 constraints, none broken by a judged row. Only 3,032 of those cells are a real test: the 2,960 cells of the 20 study rows and the 72 the closure judges scored. The other 1,556 cells of the closure rows are the attribution's own predictions, written into the cards, so they reproduce by construction. Before the families judged (the attribution at commit 12defff), it predicted 63 of the 72: all 25 of family A's and 38 of family B's 47. The other nine (SC-06 S on three rows, and the six crossing cells of section 4.5) were then written into the attribution (computed here, `a5.py`). So the code reproduces every judged cell, and before the blind judging it had predicted the frontier rows' judged cells 63 times in 72.

### 4.3 Step 2: the search

`closure.py search` builds every mix within two axis changes of each study row (BUY left out) and of seven hand-priced rows (draft 2's six and one more), drops the mixes a constraint forbids, predicts each one's cells, mechanisms and pairs, and ranks the rows that are in by rule 3. Then it walks four more rounds out from the 25 best. The ladders report 363,776 rows searched on the loose reading (15,432 of them in) and 379,172 on the strict reading (16,231 in) ([ladder-restated.md](judging/closure/results/ladder-restated.md), [ladder-restated-DATA-01_reading.md](judging/closure/results/ladder-restated-DATA-01_reading.md)); this revision reran both and got the same counts.

The search does not seed from the 11 closure rows, and it never reaches TiKV-TS or TiKV-persisted, which are 6 axis changes from the nearest seed. So their neighbourhoods were not walked. A shell of every mix within two axis changes of the 11 (about 21,500 more per reading; computed here, `dump.py`) adds no beater of COMP2 with 3 or fewer guessed cells on the strict reading. On the loose reading it adds one row with one guessed cell that beats TiKV-TS (section 4.4).

### 4.4 Step 3: rows far from any judged row win only on guesses

A predicted cell is only as good as the judged rows behind it. The **ladder** ranks the rows that are in as more guessed cells are allowed.

**A correction to the ladder files.** Rule 3 is not transitive. Two rows tie on the novel count when they are fewer than 2 apart, so a row 2 above the fewest can beat a row 1 above it while it loses to the row with the fewest. Then rule 3 can cycle, and no row beats all the others. The ladder files' column "Rule 3 unbeaten" comes from `closure.unbeaten()`, a shortcut: it keeps only the rows within one novel mechanism of the fewest, then takes the most SHOULDs and the fewest pairs. Where rule 3 cycles, the shortcut still prints a row, and that row is beaten. The ladders also skip 4 guessed cells. The tables below apply judging.py's rule pair by pair to the same searched rows (computed here, `pairwise.py`; the tool fix is in section 11). The matrix's eight lines and the two PERF-01-loss ladders are clean: each has a row no other row beats.

**Strict reading** (the searched rows of [ladder-restated-DATA-01_reading.md](judging/closure/results/ladder-restated-DATA-01_reading.md), pair by pair):

| At most this many guessed cells | Rows in | Unbeaten pair by pair | Novel / SHOULDs / pairs / open | Its guessed cells |
|---|---|---|---|---|
| 0 to 3 | 76 to 433 | COMP2, with twins that tie it on rule 3's counts (V=full, H=both, H=srv, U=cli H=srv; from 1 guessed cell, L=ts) | 3 / 6 / 277 / 98 | none |
| 4 | 495 | COMP2 with D `win` and the draft's journal (S `jrnl +tier`) | 4 / 6 / 275 / 99 | P-07, SC-05, SC-06 (S), SC-15 |
| 5 to 148 | 580 to 16,231 | none: rule 3 cycles | | |

At 5 the cycle is: COMP2 beats PD+fix with sessions, sagas, a journal and `par` (2 / 5 / 275; 1 apart, one more SHOULD); that row beats PD+fix with K `lib`, sessions, sagas and a Rust core called from Node (1 / 4 / 277, 5 guessed cells; 1 apart, one more SHOULD); and that row beats COMP2 (2 apart). The ladder file prints the 2 / 5 / 275 row at 5, and rows of PD's and SPLIT2's families further out; each of them is beaten.

**Loose reading** (the searched rows of [ladder-restated.md](judging/closure/results/ladder-restated.md), pair by pair):

| At most this many guessed cells | Rows in | Unbeaten pair by pair | Novel / SHOULDs / pairs / open | Its guessed cells |
|---|---|---|---|---|
| 0 | 109 | PD+fix with forwarding, `kw` threads and `par`: TiKV-TS's native twin (TiKV-TS itself is in the matrix and ties it) | 0 / 4 / 244 / 122 | none |
| 1 to 148 | 496 to 15,432 | none: rule 3 cycles | | |

At 1 the cycle is: TiKV's shape with client sessions and sagas in place of two-phase commit (1 / 5 / 253) beats TiKV-TS (1 apart, one more SHOULD); the same shape with a dedup window (D `win`) in place of sessions (2 / 5 / 252) beats the sessions row (1 apart, SHOULDs level, one pair fewer); and TiKV-TS beats the window row (2 apart). Both rows guess only DATA-03, which is open for them under any rule. The ladder file prints the 1 / 5 / 253 row at 1 to 8.

**Why the far rows rise.** A guessed cell falls to its part's fallback verdict, which is usually "open". Rule 3 never counts open MUSTs. So a row that drifts away from every judged row pays nothing for the cells nobody looked at. On the strict reading every row that beats COMP2 carries 4 or more guessed cells, and from 5 up rule 3 names no winner at all. That is movement on guesses, not on evidence.

**Who beats the two winners, and on how many guesses** (computed here, `beaters.py`, with judging.py's pair-by-pair rule on the same search, then with the shell of section 4.3):
- **Strict reading, COMP2.** No row with 3 or fewer guessed cells beats it, with or without the shell. The first that does needs 4 (P-07, SC-05, SC-06 (S), SC-15): COMP2 with D `win` and the draft's journal, 4 / 6 / 275 (and its V=full twin, in the shell). It wins by 2 pairs while adding the dedup window, a novel mechanism. One row needs 5 guesses, 20 need 6, and the other 6,199 beaters need more.
- **Loose reading, TiKV-TS.** Five rows with one guessed cell (DATA-03) beat it; the shell adds a sixth, TiKV-TS's own twin with sessions and sagas. But these are beaten in turn, and rule 3 cycles. So on the loose reading the family is settled but no member is, and a judging pass on one row cannot settle it (section 9).
- **Loose reading, COMP2.** Thirteen rows with no guessed cell beat it, all of PD's family with 0 novel mechanisms (27 with the shell).

### 4.5 Step 4: the frontier rows, judged blind

The search's best rows under the main readings, and draft 2's hand-priced rows, went to two families of blind judges: **family A**, COMP2 and its neighbours (8 rows: MIN-P+m, COMP2, COMP2 V=full, COMP+par C=cent V=full, MIN-P+par, MIN-P+par V=full, MIN-P+par C=cent V=full, SRV V=full Y=fwd), and **family B**, TiKV's shape (3 rows: TiKV-TS, TiKV-persisted, PD+fix). Two judges per family scored each cell no judged row supported, every crossing they saw, and each row's mechanism list; a referee settled each family ([A.settled.json](judging/closure/hybrids/A.settled.json), [B.settled.json](judging/closure/hybrids/B.settled.json)). That was 72 cells: 25 in family A, 47 in family B.

**Did the judges agree with the predictions?** Mostly.
- **Family A:** both judges gave the same verdict on every cell both scored (25 of 25; one cell only one judge scored), and every cell came out as predicted: F-22 (M and S) met on the `par` rows, SC-05 and F-12 open, SC-03 and SC-10 failing as worded like every row. No crossing was upheld. The mechanism lists moved a little: three record fixes added 3 pairs to every `par` row (274 to 277 for COMP2; RF-01 to RF-03), and learners stay in the V `full` rows as the healer's catch-up stage, so COMP2 V=full equals COMP2. Both judges also added link pings to the separate-controller rows; section 7.5 shows that this one ruling keeps COMP2 ahead of COMP+par C=cent V=full.
- **Family B:** the two judges agreed on all 41 unsupported cells. All predicted cells but one held: SC-06 (S) came out met, not open (the critic had flagged that rule). Crossings opened six cells the prediction had copied from judged rows: TEST-07 and DEP-20 on TiKV-TS (raised by both judges), and P-15 (M and S) on TiKV-TS and PD+fix, the rows with the `memory` rung (raised by judge 2 alone; judge 1 kept "met"; the referee upheld judge 2). Learners stay in TiKV-TS and TiKV-persisted (+7 pairs when ruled; +8 since RM-08 added link pings, which learners pair with).
- **After the families:** a referee carried family B's P-15 trace over to the saga rows with the `memory` rung (RR-11), and found that TiKV's own source keeps pinged links between stores, so PD's family carries link pings (RM-08: +9 pairs). On every line of the matrix, the winner stayed the same.

### 4.6 Draft 2's two unjudged rivals, now

- **PD+fix** was judged (family B): 0 novel, 3 SHOULDs, 247 pairs, 122 open MUSTs, no MUST failed restated (V-02's F-15 and OPS-14 point is settled: both open). On the strict reading it fails DATA-01. On the loose reading it loses to TiKV-TS, which meets one more SHOULD (F-22 S, through `par`).
- **SPLIT2** (SPLIT made like COMP2) was not judged. Built as draft 2 described it (N `tier` kept), it has 3 novel, 6 SHOULDs, 273 pairs and 100 open MUSTs; with N `proc`, 269 pairs (computed here, `seeds.py`; V-01). It ranks above COMP2 by 4 to 8 pairs, but only on 15 or 16 guessed cells, mostly pattern MUSTs. That is the kind of lead section 4.4 discounts.

### 4.7 The options no judged row holds

The search uses only options some judged row holds. A critic asked whether an option no row holds could rank above the frontier ([critic-unheld-options.md](judging/closure/results/critic-unheld-options.md); its prices predate the families' rulings, so it gives COMP2 274 pairs and TiKV-TS 225. The prices below come from rerunning its own script, `critic/price.py`, on today's files: COMP2 277, TiKV-TS 244). It found:
- **Nothing unheld can reach 0 or 1 novel mechanism** on a slot row: each of the three novel units (slot move, restore mark, dir lease) comes off only through options rows already hold (P `split`, T `tso` with D `txn`, S `lsm`), and no unheld option removes one without failing a MUST.
- **No unheld option can be named before a judging pass.** Each leaves the cells its axis decides unjudged: 11 for D `keys`, 15 for X `ramp`, 72 for R `vsr`.
- **Four leads could reorder the top**, each with the experiment that settles it:

| Rank | Option | What it could do | The experiment |
|---|---|---|---|
| 1 | D `keys`: one key table for fero's own retries, client sessions gone | 8 to 10 fewer pairs on COMP2's tier (267 to 269); or 3 fewer with one more novel unit (4 / 6 / 274), if the key table is novel | run E-32's dedup-and-fence crossing with E-20's `keys-fwd` rules in place of `sess`, and pin the key table's bytes at DEP-21's three loads against DEP-13 |
| 2 | X `ramp` in E-24's `rampv` form: sagas kept, atomic reads added | +1 SHOULD (P-15 S), +1 novel, +15 pairs (4 / 7 / 292): it would beat every 3-novel row on SHOULDs if only one new unit is novel | extend E-24's RAMP model to versions that carry earlier units' effects, with `rampv`'s vector; check read atomicity and a bound on rounds; ablate by DEV-10 |
| 3 | Y `proxy`: stateless proxies at the public address | 3 fewer pairs on TiKV's shape only (241) | price DEP-21 for TiKV's shape with the proxy inside its store machines |
| 4 | R `vsr`: Viewstamped Replication with protocol-aware recovery | up to 10 fewer pairs on COMP2's tier (267, if PAR sits inside VSR's log unit; 259 with D `keys` too), or one SHOULD lost (DEV-04) | cost it as Q-37 asks: two counters list its units with reads and writes; the referee rules DEV-04 (S) for a port of TigerBeetle's core |

On today's prices each of D `keys`, `rampv` and `vsr` at its best beats COMP2 by rule 3, with no MUST predicted to fail: D `keys` on pairs (or, if novel, 1 apart with SHOULDs level and fewer pairs), `rampv` on one more SHOULD at 1 apart, `vsr` on pairs. So "settled" in this page means settled among the options some judged row holds. A lead whose experiment passes still needs a judging pass of the cells its axis decides, and two counters ruling its novelty (DEV-10 (e)), before it can be named.

### 4.8 So, could an unjudged mix beat COMP2?

On the strict reading, not on evidence among the options judged rows hold. Every cell of COMP2 is judged or supported by a judged row (0 guessed cells, `seeds.py`). Its two cells no judged row supported, F-22 (M and S), were scored met by family A's two judges (V-12). Its P-15 (M) follows RR-11's rule, which the referee wrote for exactly the saga rows with the `memory` rung. The evidence skeptic read 25 of COMP2's predicted cells against the reasons of the judged rows behind them: 22 carry the same reason unchanged. Three inherit a gap that no judge looked at. P-10 (locks) and F-02 (exactly once) are met on rows whose evidence never ran the `memory` rung, though AMENDMENTS K-09 names lock fence tokens and session floors in the tail an unclean stop can lose. TEST-07 is met because undoing data's records is fast (E-06), while the state that judges a write also includes the kernel worker's compact rows and tables; that is the ground on which family B opened TEST-07 for TiKV-TS. None of the three changes a matrix line (computed here, `p10.py`, `middle.py`); all are on the re-rule list (section 11). A row needs at least 4 guessed cells to pass COMP2, and the critic's four leads need an experiment and a judging pass first. What can still move the answer is a user choice (section 8), a model that breaks a mechanism COMP2 rests on, a measurement (section 9), or a critic's lead that passes its experiment and its judging.

## 5. The winner: COMP2

### 5.1 Its full line, in plain words

| Axis | What it decides | COMP2's option | In plain words |
|---|---|---|---|
| R | how replicas agree | `raft` | Raft: one leader per group, a write commits at a majority; membership changes take effect on commit (A-01, A-02) |
| G | what one log covers | `pslot` | groups owned by the project; each holds slots of many resources |
| P | how keys map to groups | `slot` | each resource's keys hash into 4,096 fixed slots (1,024 as the fallback); a slot moves between groups; one give-up decider (A-17); moves go one at a time with a strict-improvement margin (A-18) |
| K | where the rules of writes live | `lib` | the kernel is a fenced log with five operations; dedup, conditions and ops are a deterministic library on the leader |
| C | who heals and moves | `cent-co` | one loop on `#meta`'s leader heals each group's replicas and proposes slot moves, with A-20's epoch check, two re-checks of who is alive and a timeout; platform hints are inputs to it; the slow-leader rule takes the controller's form |
| V | kinds of replica | `+lrn` | voters, plus learners (full copies that do not vote) |
| Q | what a commit means | `mix` | `persisted` by default; `memory` or `none` per resource, never per write (AMENDMENTS 4, footnote 13: `pslot` cuts groups by durability) |
| D | exactly once | `sess` | client sessions: per client, the highest sequence and cached answers, in replicated state; with `srchi-slot` marks (A-05) and caller keys (A-10) |
| O | positions | `slot` | a sequence per slot, compared as (epoch, sequence) |
| T | time, TTLs and leases | `clamp` | writer time: the leader's clock, never going back, held to the median of the members' clocks (A-23) |
| X | units across partitions | `saga` | sagas: fenced locks, an intent row and steps; a reader may see half a unit |
| S | storage | `jrnl +tier(store)` | one journal per process, plus an object-store tier; the restore mark lives in the store's manifest (A-08) |
| F | where rows are folded | `all` | every full replica folds the rows with `data` |
| W | reads and subscriptions | `any ridx` | from any ready replica at a position, or by read index |
| U | where user code runs | `any` | methods run on the server the caller reached; writes are forwarded to the leader |
| H | where fero runs | `emb` | inside the app's own Node process |
| L | language | `ts→rs` | TypeScript first; a Rust core later, checked byte for byte under the same seeds. On the strict DATA-01 reading the Rust core orders, stores and ships records but never folds rows: `data` keeps folding in JavaScript (X3's first way; section 3.3) |
| I | the Raft core | `port` | etcd's Raft ported to TypeScript ([E-10]); raft-rs later |
| Y | how a write reaches its leader | `fwd` | any server takes it and forwards it |
| M | threads | `kw` | the kernel on a worker thread; user code and a row projection on the main thread (on the strict DATA-01 reading, a full projection on every full replica, with the worker's compact rows only a cache checked against it; section 3.3) |
| Z | storage faults | `par` | a checksum per entry; a replica with a bad entry keeps its id, neither votes nor stands, and copies the entry from a peer whose commit covers it. 7 rules, each shown needed by E-37's mutants (8 of 9 caught, 89 %; or 8 of 10, 80 %, counted on the model as written), plus two the record adds: the append guard (in the model, not needed for safety, kept because F-22's words ask for it) and a read rule (a damaged replica answers END at that position; not modelled). The disk incarnation stays for the `memory` rung's unclean stop |
| N | tenancy | `proc` | one process (one Fly app) per project |

**In one line:** MIN-P (the study's minimal design with groups owned by the project) with a `memory` rung beside `persisted` and `none`, and with `par`.

**Twins that tie it.** COMP2 V=full (every replica votes; learners only while a heal catches a new copy up) ties COMP2 on every cell, unit and pair (A.settled.json). The strict ladder also lists twins on H and U that tie it on rule 3's counts. Rule 3 cannot separate them. This page keeps AMENDMENTS 4's picks (`+lrn`, `emb`, `any`): SC-14 has other regions follow through learners, and `emb` is fero's form today. The H `srv` twins pass the strict reading only while they run TypeScript: after a Rust core, a server binary has SRV's shape, which the tool's DATA-01 rules do not see (they read F, K and S only).

**COMP2 in TypeScript for good** (L `ts`) also ties it on rule 3's counts (3, 6, 277), with one guessed cell (PERF-08, open either way), and has 2 fewer open MUSTs (96): DATA-09 and TEST-10 are met because there is never a second kernel. So "open MUSTs first" over the searched mixes picks it. This page keeps `ts→rs` because the native step is held for the rows TypeScript may not win (PERF-04's default row, PERF-08's native column, PERF-07's single client; section 9, step 8). Keeping it costs those two MUSTs and a second kernel, and raft-rs 0.7.0 cannot run etcd's files (G-24). If step 6's timing shows TypeScript wins those rows, L `ts` is the better row.

### 5.2 Its score

From the closure card ([cards.json](judging/closure/hybrids/cards.json)) and `closure.py`'s tally (computed here, `comp2cells.py`):
- **As worded:** 4 MUSTs failed (F-15, F-17, SC-03, SC-10; gap sum 1.32), 95 open, 33 met.
- **Restated:** no MUST failed, 98 open, 34 met. If P-10 and F-02 were opened for the `memory` rung as RR-11 opened P-15 (section 11), 99 or 100 open; no matrix line changes (computed here, `p10.py`).
- **SHOULDs:** 6 met (P-22, SC-12, F-22, DEV-04, DEV-05, OPS-11); 3 not met (P-15 S, readers can see half a saga; DEV-02 S, at most 10 pairs; DEP-15 S, two copies survive a crash, which needs a witness COMP2 does not have); 7 open (P-20, PERF-09, SC-06, DEP-10, DEP-14, DEP-19, TEST-11).
- **Novel mechanisms:** 3 of its 50 units: the slot move, the restore mark in the store's manifest, and the dir lease (one process per dir, with an epoch fence).
- **Interacting pairs:** 277.

**Its PERF-04 is open, not met.** No measurement shows any rung winning JetStream's default single-publisher row. E-02's `memory` rung read p99 0.57 ms in TS and 0.33 ms in Rust, at 50,000 writes a second with no client hop and no gateway ([E-02]), and neither beats 0.55 ms by JetStream's spread. E-02 never ran one write in flight, so it is not a ceiling for this row either. The settled reason for this open cell (the Q `mix` rule in attrib/PERF-DATA.json, copied into the card) still calls Rust's 0.33 ms "a win". It was written against JetStream's 0.55 ms, before RR-04 set the win bar near 0.30 ms. So the reason left for "open" (one working point is no ceiling, as RR-02 and RR-03 ruled for P-05) is this page's, not a referee's (section 11). A reasoned floor of about two 58 µs round trips is well under 0.30 ms, so no ceiling is known either way. This is MIN-P+par's best argument: the rung adds 13 pairs, opens P-15 (M), and exists only to win a row no measurement shows it winning. That is why section 9 builds without it first.

### 5.3 What it gives up

All of this is reasoned or measured; none of it is counted by rule 3.
- **Against leader healing (COMP):** 4 more healing rules (18 against 14, [E-16]) and a stuck state as first written, which A-20 removes. While `#meta` has no leader, healing waits as well as moves (24 to 62 % of the judged states could not finish healing then: a delay, not a stuck state). 9 of the controller's 21 mutants are undecided (G-09). It drops COMP's K-27 (no one decides a give-up), and turns K-07 into the controller healing and moving at once.
- **`par`:** 7 rules against `rejoin`'s 2, plus the append guard and the END read rule of the record (section 5.1), checked with three voters and no voter change (G-15) and not on one journal per process (K-24). Since RF-03 it pairs with the group's config, so the voter-change crossing now shows in the count.
- **The `memory` rung:** its safety inside Raft was never modelled (K-09, G-05). A saga with one step on a `memory` resource can be left half done if that group's majority stops uncleanly within the second before the disks catch up, so P-15 (M) is open until a stated rule closes it (RR-11). RR-11's closer has two halves: a unit's steps on a `memory` resource commit at `persisted`, or the unit is refused. The first half needs a rung chosen per write, which COMP2's Q forbids (footnote 13: never per write, because `pslot` cuts groups by durability). So for COMP2 the closer is refusal: no saga step, fence raise or end record on a `memory` resource. The same lost tail can hold lock fence tokens and session floors (K-09), so P-10 and F-02 carry the same gap, which no judge ruled (section 11). The simplest rule closes all three: locks, fences, sagas and session tables never sit on a `memory` resource. And the rung exists only to win a row no measurement shows it winning.
- **Cost:** one process per project with its own volume. Awake all month it costs $2.34 against the $2.19 free bar ([E-41]); at 10 writes a second it passes $10 at the top of its range in São Paulo, Johannesburg, Tokyo and Singapore or Sydney (section 6).
- **Outside services:** as worded, a slot move waits while the object store is down (F-15).

### 5.4 Every MUST it leaves open (restated: 98)

REQUIREMENTS rule 1 asks this page to list each open MUST with what closes it. The lines come from the "What closes it" column of [judging/rows/COMP.md](judging/rows/COMP.md), whose cells COMP2 shares except F-22 (met here); lines that name COMP's leader healing take MIN-P's closer ([judging/rows/MIN-P.md](judging/rows/MIN-P.md)). The set was checked against `closure.py`'s tally (`comp2cells.py`): draft 2's 97 plus P-15. P-10 and F-02 may join it (section 11).

*A choice of the user's comes first (13).*

| Requirement | What closes it |
|---|---|
| P-02 Cache with expiry, session store | the user's reading of the expiry bound (item 20); then the expiry-tick pin at 1e3 to 1e6 rows (phase 2) |
| F-07 Restart in any order | the user's reading of the two-voter window (item 20); then v4's stopsOneByOne harness on the port, with a stop inside that window |
| SC-03 Scale writes up | SC-03 restated with the app split and F_w at most 135; then the phase-4 sim with the real mover at n = 1 to 32, and the 1-to-4-process pin |
| SC-10 Only stated ceilings, each above its floor | restated as SC-03; phase 1 fixes the list of ceilings and the slot count (4,096, or 1,024 if the cursor is too big); each phase pins them |
| SC-13 Many resources | the user defines "small" (few slots touched); phase 1 fixes the formats; the sim that makes and drops 1e5 resources through `fero()`; K-04 and K-06 |
| SC-14 Region scope | the region scope; the phase-2 sim with 80 to 150 ms links |
| SC-15 Sizes and neighbours | whether 1.18 and 1.26 times against 1.2 counts as met; E-35's load inside one Raft group, and the 1 MB, 64 MB and `too-large` tests (phase 2) |
| F-05 Failover time | the handover bar restated or kept open (RR-01); pins on three processes of the port with A-02's constants and the refuse-at-once handover (phase 2) |
| F-15 Outside services | slot moves added to F-15's list, or the mark moved; a sim with the store down for 1 h (phase 3; K-21, K-23) |
| F-17 Partial partitions | F-17 restated, or read the clique way; the 3- and 5-node sweeps and one real-TCP run with CheckQuorum every E/4 and 0.25 E jitter |
| SC-08 Without worry | (b) restated, or the move cut to one or two commits and modelled with its carried set (K-03, K-25); the phase-4 sweep with scale events |
| DEP-17 The platform is the planner | whether a hint may change membership; a model or sim of the controller with stale, duplicated and reordered hints (K-08) before phase 2 |
| DEP-21 Cost is a number | whether the free bar is judged asleep or awake (RR-09); where the 100 subscribers run, in which region, and whether the Fly organization has granular transfer rates; the AWS prices and Fly's rate to Tigris read at the source; E-41's cost.py run again |

*A model to write first (9).*

| Requirement | What closes it |
|---|---|
| P-15 Transactions across partitions | the stated rule that the saga library refuses a unit with a step, fence raise or end record on a `memory` resource (RR-11's other half, a per-write `persisted` commit, is not open to COMP2: footnote 13), and E-24's saga model rerun with a group that can lose its unsynced tail, once without the rule and once with it (RR-11) |
| P-06 Pub/sub | the `none` rung built and its failover rule modelled (K-10); then `nats bench` and `nats latency` through E-45's NATS gateway |
| F-08 Deleted rows stay deleted | a restore model with removes; the phase-2 sim monitor seeded with v4's two row-comes-back bugs |
| F-12 Majority loss | a model of unclean recovery with lock fence tables, the `memory` rung (K-09) and `par`'s repair; recovery tests in phase 3 |
| F-18 Fail-slow | build and model the slow-leader rule in the controller's form (K-17); then the sim with per-node latency and one dm-delay or io.max run |
| DEV-02 Few interactions | models for COMP2's 81 open pairs: MIN-P's 61 (E-32 pairs.md sections 7 and 9: K-01 to K-28, FORKPIN, WTAIL, SRCMOVE, PREVOTE, RESTORENAME), 11 of the `memory` rung (K-09, K-05) and 9 of `par` (G-15, K-24 and the rest; section 7.6) |
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
| DATA-06 Faults stay in user land | V4-47's tests re-run on the v5 composer at each place data closes a commit |
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
| OPS-12 Upgrades both ways, and the fold's version | the record header with the five pins; a roll across two builds and two data versions with F-21's hashes equal |

*A build and a measurement: phase 2 (32).*

| Requirement | What closes it |
|---|---|
| P-01 Live shared state | the persisted-write p99 pin on the real kernel (PERF-08's pin), and example 02 on three real processes |
| P-11 Counters and rate limits | the pin for a conditional op at the writer on the real L2 (PERF-10's pin) |
| P-22 Delayed jobs, waiting takes, priorities | the writer-time stamp op in L2 (a phase-1 API shape), then the waiting-take wake pin |
| PERF-01 Fair comparison | a real kernel behind E-45's gateways, each competitor's own tool in the same hold; the native step for the single-client tail rows |
| PERF-02 Redis 7 | memtier through the RESP gateway: about 92,000 persisted SETs a second at 200 connections with p99 under 4.9 ms; the pipeline-16 default rows need the `memory` rung or the native step |
| PERF-04 NATS JetStream | `nats bench js` with one write in flight: `persisted` against sync always, `memory` against JetStream's default, below about 0.30 ms to count as a win; the native step if TS does not get there |
| PERF-05 Kafka | Kafka's own tools through the Kafka gateway, 16 partitions, same hold; a 1 KiB `memory` run for the default max row |
| PERF-06 Redpanda | Kafka's own tools against Redpanda, same hold; TS must keep 62 % of the protocol-free ceiling, so likely the native step |
| PERF-07 etcd | etcd's `benchmark` through the gRPC gateway; the one-client put p99 must come under 1.73 ms |
| PERF-08 Commit latency | p99 commit at 50,000 writes a second on the pipelined kernel with the real Raft core, `fio` floor beside it |
| PERF-10 Reads and ops | pins for the conditional op, the method call at the writer, the held-row read and the `fresh` read |
| PERF-13 Nothing on a timer grows with data | CPU per tick of retention and compaction at 1e3, 1e5 and 1e7 rows |
| DATA-07 Rows handed out are immutable | the mutation test over every hand-out path, with the held-row read pin |
| SC-02 Same code at every size | the example series unchanged on 1, 3 and 5 processes; a hosted run |
| SC-07 Members | the sim sweep at n = 1 to 100 with failures injected |
| SC-09 Limits warn before they bite | one test per limit as each lands: disk in phase 2, the rest by phase 4 |
| F-06 No false failovers | the sim with pauses up to 1 s on kernel threads and CheckQuorum at E/4 (K-28), and the median with one or two clocks and a changing member set (K-11) |
| F-09 Every loss is said | one test per failure kind; the sim monitor for silent waits over 2 × election.ms |
| F-10 Disks | the sim's disk model, or a block-level tool (dm-flakey, dm-log-writes), for a failed fsync and a lost directory entry |
| F-13 Bounded | one test per bound; the 24 h soak at max rate in phase 4 |
| F-16 Returning members | the sim's partitions from 10 s to 1 h with retention and snapshot catch-up; a pin on the bytes copied after the log was cut |
| F-19 Overload and storms | E-39 rerun with a server grant and many clients; 1,000 groups failing over; the storm behind a TLS terminator |
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
| P-18 Tapes, forks, replays | the fork on the snapshot and segment store, with TEST-06's pin and the cut per partition across groups |
| P-20 Change the shape of rows | P-16's contract; a tape replayed across a shape change; the migration on example 43 under load |
| P-21 Request and reply | a service on the `none` rung timed with `nats bench` request/reply; or the bar restated as three commits (E-22 D7) |
| PERF-03 NATS core | `nats bench` and `nats latency` through the NATS gateway on a real `none` path; the native step if TS stays over NATS's 0.27 ms p99 |
| PERF-14 Never widen | a pinned quiet runner, each bar entered as a pin in `npm run perf`, then the CI history |
| DATA-05 Views are data's operators | data emits per-row `group` deltas and shares equal views; then P-12's pins |
| SC-04 Scale down | the 7-day daily-load-cycle sim with the real mover and its thresholds (phase 4) |
| SC-05 Scale to zero and back | a built wake path (native crc32c, blind writes while the fold catches up) timed at 10 GB; then sleep and wake with disks kept and lost |
| SC-11 Hosted, many tenants | two projects on the deploy target's volumes under E-35's load, one at quota; 1,000 sleeping projects on the box |
| DEP-07 One public address with TLS | the client test through one proxy address with a TLS terminator |
| DEP-10 Contracts before the roll | the deploy test with a changed rule and A-10's five pins |
| TEST-08 Captures line up | the viewer test on v5 captures |
| OPS-04 Debugger | the DOM gates on v5 captures and a live cluster |
| OPS-05 Mixed versions | the roll test across two kernel builds |
| OPS-06 Security | door and TLS tests, and a rotation under load |
| OPS-07 Backup, restore and point in time | a restore to a past position with an outside token holder, and an export round trip |
| OPS-10 Per-user access | the hostile-client suite, a revocation under load, the 2 µs pin |
| OPS-13 Erase | erase tests across every store; a deleted project's bytes unreadable once its key is gone |
| OPS-14 A shared tier keeps projects apart | a key per project at rest and a cross-project read attempt |

*A build and a measurement: the native step (2).*

| Requirement | What closes it |
|---|---|
| DATA-09 A native kernel keeps data | on the strict reading: the native step keeps `data` folding in JavaScript, so DATA-09 holds by construction, and A-30's twin guard checks that the Rust core hands data the same records the TS kernel would. On the middle or loose reading: the differential test of a native fold against data on E-43's stream, 1e6 records, state compared |
| TEST-10 Same kernel bytes | a Rust core that passes etcd's files, then A-30's guard over 1,000 seeds; or the Rust kernel run as WASM in the sim. raft-rs 0.7.0 cannot run etcd's files (G-24) |

**Every other row's list** is in its scorecard: [judging/rows/](judging/rows) (one `<ROW>.md` per row) for the 20 study rows (rebuilt with the re-rulings), and each closure row's 148 cells with their reasons in [hybrids/cards.json](judging/closure/hybrids/cards.json). `python3 tools/closure.py card '<changes>' <BASE>` prints the same for any mix (V-15).

## 6. Every other row

"Novel" is the settled count after the re-rulings. "A" is as worded (OUTCOME A.2's place for the 20; MUSTs failed in brackets). "B" is restated, on the loose and the strict DATA-01 reading. Computed here (`standings.py`) for the closure rows.

| Row | What it is | Novel | A | B (loose / strict) | Open MUSTs (B) | Why it does not win (strict reading) |
|---|---|---|---|---|---|---|
| COMP2 V=full | COMP2 with every replica a voter | 3 | (4) | in / in | 98 | it ties COMP2 on every count; COMP2 keeps AMENDMENTS' `+lrn` |
| COMP | the study's composite: leaders heal, Z `rejoin` | 3 | 4 (4) | in / in | 98 | 5 SHOULDs against 6: without `par` a group with a bad entry on two replicas can stall (F-22 S) |
| MIN-P+m | COMP2 with `rejoin` in place of `par` | 3 | (4) | in / in | 98 | 5 SHOULDs against 6 (F-22 S) |
| COMP+par C=cent V=full | COMP2 with a separate controller that tracks members by sessions | 3 | (4) | in / in | 99 | 282 pairs against 277: its controller sessions, for no cell. Family A's link-pings ruling decides this: without it the row prices 272 and beats COMP2 (section 7.5) |
| SPLIT | groups that split and merge by size and load, each leader heals | 4 | 1 (3) | in / in | 101 | 1 apart on novel, 5 SHOULDs against 6 |
| DRAFT | DESIGN-V5 as of 2026-11-05 | 5 | 1 (3) | in / in | 99 | 5 novel against 3 |
| MIN-P+par | COMP2 without the `memory` rung | 3 | (5) | out on PERF-04, both | 96 | only `persisted`, which cannot beat JetStream's default by PERF-01's spread rule (RR-04); wins if that loss is accepted |
| MIN-P+par V=full | the same, every replica a voter | 3 | (5) | out on PERF-04, both | 96 | as MIN-P+par, which it ties |
| MIN-P+par C=cent V=full | the same with a separate controller | 3 | (5) | out on PERF-04, both | 97 | PERF-04; 269 pairs, 5 more than its twin |
| MIN-P | MIN with groups owned by the project | 3 | 9 (5) | out on PERF-04, both | 96 | PERF-04; let back in, 5 SHOULDs against MIN-P+par's 6 |
| MIN | DRAFT minus the witness, planner, group rule and window dedup; one controller loop | 4 | 9 (5) | out on PERF-04, both | 96 | PERF-04; let back in, 4 novel and 5 SHOULDs |
| RUST | MIN with a Rust core and raft-rs from day one | 4 | 9 (5) | out on PERF-04, both | 97 | as MIN |
| LEAN | MIN where only leaders fold | 4 | 9 (5) | out on PERF-04, both | 96 | as MIN |
| MIN-TS | MIN in TypeScript for good | 4 | 9 (5) | out on PERF-04, both | 94 | as MIN; once the loss is accepted it has the fewest open MUSTs of the rows in, so "open MUSTs first" picks it |
| SIDE | MIN with a native daemon per host | 4 | 9 (5) | out on PERF-04, both | 99 | as MIN |
| RLOG | Raft on log members; a server writes by a committed writer epoch | 4 | 5 (4) | out on PERF-04, both | 96 | as MIN |
| EMB-V8 | SRV with V8 embedded | 4 | 5 (4) | out on PERF-04, both | 99 | as MIN |
| SRV | MIN as a Rust or Go server binary | 4 | 5 (4) | out: PERF-04 / out: PERF-04, DATA-01 | 102 | PERF-04; on the strict reading its servers fold natively (DATA-01) |
| SRV V=full Y=fwd | SRV with every replica a voter, writes forwarded | 4 | (4) | out: PERF-04 / out: PERF-04, DATA-01 | 102 | as SRV |
| SLOG | the earlier log-first draft, with slots | 5 | 5 (4) | out on PERF-04, both | 117 | PERF-04; let back in, 5 novel against 3, so it loses on the novel count (V-13) |
| ISR | Kafka's shape: leader and in-sync set under a controller | 2 | 1 (3) | out on SC-03, SC-04, SC-10, both | 117 | a fixed partition count gives 23 to 53 writers' worth at 64 groups under skew even with the app split ([E-18], a ceiling); no rule merges a group (structural) |
| LANE | 64 lanes per project | 3 | 9 (5) | out on PERF-04, SC-03, SC-04, SC-10, both | 95 | PERF-04; 64 shared lanes give one resource 23 to 53 writers' worth ([E-18]); no rule removes a lane |
| CELL | 16 cells per resource, re-keyed to grow | 4 | 16 (6) | out on OPS-01, P-07, SC-03, SC-08, SC-10, both | 98 | a re-key refuses old cursors ([E-17], [E-31]); 7 to 15 writers' worth ([E-18]); a write waits for the re-key ([E-17c], counterexample); a person picks the cell count |
| PD | TiKV's shape: split and merge, a controller, timestamps, two-phase commit | 0 | 17 (6) | out: F-22, PERF-04, SC-05 / and DATA-01 | 117 | no checksum per entry, so a committed write is overwritten in 32 states ([E-37]); state on local disks with no tier, so a wake after lost disks keeps nothing; PERF-04 |
| PD+fix | PD with the disk incarnation, an object-store tier and the `memory` rung | 0 | (3) | in / out: DATA-01 | 122 | strict: DATA-01. Loose: 3 SHOULDs against TiKV-TS's 4 |
| TiKV-TS | PD+fix in TypeScript first (ported Raft), with `par`, forwarding and every replica a voter | 0 | (3) | in, **wins** / out: DATA-01 | 122 | strict: DATA-01 (section 3.3) |
| TiKV-persisted | TiKV-TS without the `memory` rung, as a Rust or Go server | 0 | (4) | out: PERF-04 / out: PERF-04, DATA-01 | 120 | PERF-04; wins on the loose reading if the loss is accepted. Its strict DATA-01 failure comes through SRV's rule in the tool, though its engine is PD's (section 11) |
| OBJ | the object store is the log | 2 | 18 (9) | out on 7 MUSTs, both | 111 | every commit is a conditional PUT, p99 about 80 ms on S3 Standard against 5.7 ms ([E-28]); a store that is down stops writes; about $136 a month against $10 ([E-41]) |
| BUY | fero's upper layers on NATS JetStream; a reference row | 0 | 19 (27) | out on 27 MUSTs, both | 96 | the sim cannot run nats-server's bytes (TEST-10, DEV-07); a retry lands twice once JetStream's dedup window has passed ([E-44]); it cannot beat what it is built on |
| V4 | v4 as it is | 8 | 20 (50) | out on 50 MUSTs, both | 64 | two sells of the last item through two servers both answer ok (P-14, v4 measured); F-01 and F-02 pinned red in v4's own sim |

**DEP-21's written reasons.** DEP-21 asks this page to give a reason for each row that costs more than twice the cheapest at any load. The figures are E-41's ([E-41], cited prices) and its price re-check of 2026-11-10, which read Fly's and Tigris's prices at the vendors' own docs sources and bills the upload to Tigris at $0.006 to $0.02 a GB, a rate Fly does not name ([recheck/results](experiments/E41-hosted-cost/recheck/results)). Ratios are computed here at the same transfer bound (`ratios.py`). E-41 did not price the closure rows; each is given the shape it shares (reasoned): COMP2's family has MIN-P's shape, SRV V=full Y=fwd has SRV's, and PD+fix, TiKV-TS and TiKV-persisted have PD's.
- **A sleeping free project.** The cheapest row, EMB-V8, costs $0.00, so every other row is "more than twice" it and a ratio says nothing (E-41 says so too). In dollars every row is under the $2.19 bar: $0.04 for DRAFT's family, SLOG, RLOG and OBJ; $0.19 for MIN's shape (COMP2's family, ISR, V4); $0.23 for SRV's and PD's shapes; $0.60 for BUY. The spread is the stopped machine's root disk and a 1 GB volume for rows that keep their own disk.
- **10 writes a second, Fly, cheapest region (iad).** The cheapest row is DRAFT's shape, $5.17 to $5.54. Over twice that:
  - **OBJ**, $136.02 to $136.39 (24.6 to 26.3 times): every commit window is a PUT, about 26.3 million a month.
  - **SRV** and SRV V=full Y=fwd, $11.97 to $12.34 (2.2 to 2.3 times); **PD** and PD's family, $18.64 to $19.01 (3.4 to 3.6 times); **BUY**, $16.14 (2.9 to 3.1 times): the app runs on machines of its own beside the servers, and PD adds three placement machines. PD's family also uploads about 26 GB of log a month to its tier, $0.16 to $0.53. With the placement process inside the three stores and one app machine, PD's shape costs $9.58 to $10.11 (about 1.8 to 1.9 times), which is why RR-06 kept PD's DEP-21 open.
  - COMP2's shape is $7.52 to $7.89 (1.4 to 1.5 times), under the $10 bar in iad and ams.
- **10 writes a second, AWS** (E-41's cited prices, not re-read): OBJ 20.5 times, PD 3.9, SRV 2.5 and BUY 2.5. The causes are the same as on Fly.
- **5,000 writes a second, Fly.** In E-41, only OBJ is over twice the cheapest (17.5 times EMB-V8's $79): one PUT per 10 ms window. With the upload billed, BUY ($136), which keeps no log in the object store, becomes the cheapest row, and every other row but OBJ costs $158 to $393: 1.2 to 1.5 times BUY at $0.006 a GB, and 2.5 to 2.9 times at $0.02 a GB. The reason is the upload itself, 13,140 GB a month. BUY is E-41's reference row and never the base of its ratio; against EMB-V8, the cheapest row that is not the reference, only OBJ is over twice (4.8 to 9.3 times). Compressing the log, or uploading compacted state, would cut it (reasoned).
- **5,000 writes a second, AWS:** OBJ is 2.3 times the rest on S3 Standard; every three-copy row pays about $526 of traffic between zones, so the others end within 1.1 times of each other.
- **COMP2 in other regions:** at the top of its range it passes $10 in São Paulo ($11.86 to $12.52), Johannesburg ($10.70 to $12.54), Tokyo ($9.81 to $10.46) and Singapore or Sydney ($9.55 to $10.21) (V-04). Same-region traffic is free only for a Fly organization on granular data-transfer rates.

## 7. How sure

### 7.1 The judges' agreement

From [OUTCOME.md](judging/OUTCOME.md) section 1 (the first settlement of the 20 study rows):

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

A decisive difference is one that could change the ranking. The closure judges agreed on every cell both scored. On four crossing cells (P-15 M and S on PD+fix and TiKV-TS) only judge 2 raised the crossing, and the referee upheld it (section 4.5). Those four set TiKV-TS's P-15 (S), so its SHOULD count, and the trace RR-11 carried over to COMP2. But the leading rows barely differ on cells: COMP2 differs from COMP only on F-22 (S), and from MIN-P+m only on F-22 (S). So the order at the top is set by the mechanism catalogue and the pair counts, not by the judges. The reads and writes that make the pairs were written once ([mechanism-list.json](judging/mechanism-list.json)) and checked by a second agent only for the most-carried pairs and the pairs between novel mechanisms ([pairs.md] section 9).

### 7.2 The re-rulings since draft 2, and what each changed

| Id | What was asked | Ruling | What it changed |
|---|---|---|---|
| RR-01 | F-05 (M) as worded, the 15 Raft study rows | fails → open | outcome A's top: the Raft rows lose a failure |
| RR-02, RR-03 | P-05 (M) as worded, 18 rows | fails → open | outcome A's top, with RR-01: DRAFT, SPLIT and ISR level |
| RR-04 | PERF-04 (M), the 12 `persisted`-only rows | fails, on PERF-01's spread rule now, not "C is a floor"; gap 0.33 → 0.39 (0.06 to 0.39 by how the round trip is counted; section 2) | no order above place 16 of outcome A |
| RR-05 | F-02 (M), DRAFT, LANE, SPLIT | met → open: the dedup window was never checked beside fence tokens (E-32's crossing) | met counts fall by 1 |
| RR-06 | DEP-21 (M), PD: fail it? | rejected: kept open ($9.58 to $10.11 with placement inside the stores) | nothing |
| RR-07 | DATA-01 (M), PD: fail it? | rejected: kept open; the strict reading named as the user's | nothing as the cells stand |
| RR-08 | F-17 (M): fail only on the star reading? | rejected: kept failing; the clique reading named as the user's | nothing as the cells stand |
| RR-09 | DEP-21's free bar, the MIN-shaped rows | rejected: judged asleep; the awake reading named as the user's | nothing as the cells stand |
| RR-10 | DATA-01 (M), SRV and PD | records the user choice: on the strict reading both fail by structure | the matrix's DATA-01 column |
| RR-11 | P-15 (M), the saga rows with the `memory` rung (DRAFT, CELL, SPLIT, COMP) | met → open | those four and, through the attribution, COMP2's family: one met MUST becomes open each (COMP2 97 → 98); no winner |
| RM-01 | does SPLIT carry the merge? | yes | SPLIT 278 → 295 pairs |
| RM-02 | are log replicas novel? | no: TiKV's witness, read at the source | DRAFT 6 → 5, SPLIT 5 → 4, CELL 5 → 4, LANE 4 → 3 |
| RM-03 | is `par-repair` novel? | no (PAR is its precedent) | nothing |
| RM-04 | add planner hints to the controller rows? | no: they hold the hint path in units they have | nothing |
| RM-05 | does CELL carry planner hints? | yes | CELL 262 → 277 pairs |
| RM-06, RM-07 | are the dedup window and dormant groups novel? | yes, both kept (Neon's eviction checked at the source) | nothing |
| RM-08 | does PD carry link pings? | yes: TiKV pings each store link and wakes quiet regions on a broken one | PD 209 → 218 pairs; PD's family +9 |
| RM-09 | do ISR, SLOG and OBJ? | no: they use controller sessions or leases | nothing |
| RF-01 to RF-04 | `par-repair`'s rules and reads; quiet groups' wording | three record fixes, one wording fix | every `par` row +3 pairs (COMP2 274 → 277) |

### 7.3 Every flip in OUTCOME A.3 and B.3

| Outcome | The change | Winner then | Why (computed here, `aflips.py`) |
|---|---|---|---|
| A | judge 1 alone, before the referee | ISR | each judge's own cells come before the re-rulings, so F-05 and P-05 still fail for the Raft rows (and judge 1 also fails DRAFT's and COMP's SC-13). ISR, whose F-05 and F-17 were never run, fails 4; DRAFT fails 6, SPLIT 5 |
| A | judge 2 alone | ISR | the same; judge 2 also fails SPLIT's SC-04 |
| A | PERF-01 losses accepted | level: DRAFT, SRV, SPLIT, ISR, SLOG, RLOG, EMB-V8 | PERF-04 opens, and SRV, SLOG, RLOG and EMB-V8 drop to 3 MUSTs with 1.32 |
| A | no tier shared between projects | ISR | DRAFT, SPLIT and SLOG fail OPS-14, so ISR alone has 3 among the 20. Over the 31 rows: ISR alone on the strict reading; ISR, PD+fix and TiKV-TS level on the loose one (computed here, `a4a7.py`) |
| B | every open SHOULD counted as met | SPLIT | SPLIT has 8 open SHOULDs (DEP-15 S among them) against COMP's 7: 13 against 12, and 4 novel against 3 is only 1 apart |
| B | PERF-01 losses accepted | MIN-P | the ten `persisted`-only rows come back; MIN-P has COMP's 3 novel and 5 SHOULDs, and 252 pairs against 283 |
| B | "other" readings, or F-07, P-02 or P-13 alone | level: DRAFT, SPLIT, COMP | each reading fails one MUST for every one-writer row, with no gap (F-07: the two-voter window counted as a counterexample; P-02: 2,036 ms late against 350 ms after a failover near the ttl; P-13: 12.4 s after a `#sessions` failover, [E-22]); rule 2 has no tie-break |

### 7.4 The sweep over all 31 rows

The matrix's flips are explained in section 3.2. Here is OUTCOME's sweep run over the 31 rows, from each of the two winners (computed here, `sweep31.py`).

**From COMP2 (restated, strict, no loss).** COMP2 keeps the win with every open SHOULD counted as met or as not met, with SHOULDs first, with open MUSTs first, with `par-repair` counted novel (4 against MIN-P+m's 3: one apart, and COMP2 has one more SHOULD; V-18), the other way on N_res, region scope, the shared tier and the fsync figure, with DEV-01's or PERF-08's reading flipped, with 15 of 16 SHOULDs left out one at a time, and in 55 of 62 lines that give one row 2 more or 2 fewer novel mechanisms. The sweep's F_w and F-06 lines test nothing here: among the 31 rows' cells the F_w flag sits only on CELL's OPS-01, and no cell depends on F-06. F_w above 135 is a separate, reasoned case that does move the winner (section 8, item 5). It flips in these lines:

| The change | Winner then | Why |
|---|---|---|
| PERF-01 losses accepted | MIN-P+par | the `memory` rung buys no cell, and 264 pairs beat 277 |
| DATA-01 read loosely | TiKV-TS | 0 novel against 3 |
| F-07, P-02 or P-13 read the other way | level, every row out: DRAFT, SPLIT, COMP, MIN-P+m, COMP2, COMP2 V=full, COMP+par C=cent V=full | one MUST failed each, with no gap |
| F-22 (S) left out | MIN-P+m | `par`'s only gain goes, and 264 pairs beat 277 |
| COMP, MIN-P+m or COMP+par C=cent V=full given 2 fewer novel mechanisms | that row | 1 against 3 |
| COMP2 or COMP2 V=full given 2 fewer, or 2 more | that twin alone, or the other twin | it only splits the twins |

**From TiKV-TS (restated, loose, no loss).** TiKV-TS keeps the win with every open SHOULD counted either way, with `par-repair` counted novel (1 against COMP2's 4), the other way on every user number, and with any one SHOULD left out (16 of 16). It flips in these lines: SHOULDs first, or open MUSTs first (COMP2, with 6 SHOULDs against 4 and 98 open against 122; the SHOULD lead rests on three TiKV-TS SHOULDs nobody judged, section 8 item 3); DATA-01 read strictly (COMP2); PERF-01 losses accepted (TiKV-persisted); F-07, P-02 or P-13 read the other way (every row out; the seven rows above plus PD+fix and TiKV-TS level); any of COMP, MIN-P+m, COMP2, COMP2 V=full, COMP+par C=cent V=full or PD+fix given 2 fewer novel mechanisms (that row); TiKV-TS given 2 more (PD+fix). 55 of 62 novel-count lines keep it.

**One AMENDMENTS 1.3 clause kept as worded, the rest restated** (computed here, `keepone.py`):

| Clause kept as worded | Strict reading | Loose reading |
|---|---|---|
| SC-03 and SC-10 | every row out; DRAFT, SPLIT and the 5 COMP-like rows level (2 MUSTs, 1.32) | the same, with PD+fix and TiKV-TS |
| F-17 | every row out; the same 7 rows level (1 MUST, no gap) | the same, with PD+fix and TiKV-TS |
| F-15 | SPLIT: only DRAFT and SPLIT stay in, and only while their restore mark has no home in the store | TiKV-TS: its F-15 is open, since writes and elections use the local store |
| P-05, SC-05, SC-08, SC-13, F-10, DEP-21 | COMP2 | TiKV-TS |

### 7.5 Close calls in the mechanism count

- **`par-repair`'s novelty.** Only one counter judged it (counter a: not novel, with PAR as precedent); counter b was never given it. E-37's "+1 mechanism" counts a carried unit, not a novel one. RM-03 keeps it not novel. Counted novel, COMP2 has 4 against MIN-P+m's 3 and still wins under rule 3 as written (one apart, one more SHOULD). Only a reading of rule 4 as "fewer novel mechanisms first, whatever the gap" would pick MIN-P+m.
- **Log replicas' precedent.** TiKV's witness (RFC 0106, kvproto's `is_witness`, raftstore's election priority) has the same state, rules and role, read at the source (RM-02). This moved DRAFT, SPLIT, CELL and LANE down one each. COMP2 carries no log replicas. Taken with SPLIT's merge (RM-01), COMP keeps the 20-row win; without the merge, SPLIT would have won it.
- **Planner hints.** COMP carries a planner-hints unit; COMP2 takes hints as inputs to its controller, and RM-04 found that the controller's units already hold every hint rule. Counted on COMP2 too, its C-axis margin over leader healing falls from 19 pairs to 3 (296 against 293, `hints.py`), and it still leads.
- **Learners under V `full`.** The two family-A judges split; the referee kept learners as the healer's catch-up stage, since the controller adds a replacement as a learner and promotes it ([E-16]). Without them, COMP2 V=full would price 8 pairs under COMP2 on identical cells (family A's follow-up). Family B ruled the same for TiKV's rows.
- **Link pings, and the separate-controller twin.** Every Raft row carries link pings, COMP2 included (mechanisms.json's condition). The 5 pairs between COMP+par C=cent V=full and COMP2 are its controller sessions, the one unit COMP2 lacks; the two rows differ in cells only on PERF-12 (M), a MUST. Before family A, the separate-controller rows did not carry link pings. Family A's referee added them (both judges agreed), which gives that row 10 pairs. Without that ruling it prices 272, ties COMP2 on novel (3) and SHOULDs (6), and beats it on pairs (computed here, `pairs.py`). So COMP2's lead over that twin rests on this one ruling. PD's family carries link pings since RM-08 (+9). ISR, SLOG and OBJ do not (RM-09).
- **Counter b's stricter count and `dir-lease`.** Counter b judged the `memory` rung, planner hints and the leader-form slow-leader rule novel (MECHANISMS 4.5). COMP2 carries only the first; MECHANISMS section 2 gives MIN-P 2 by counter b, so b's way COMP2 has 3 and COMP 5 (reasoned from that table), which widens COMP2's lead. `dir-lease` is novel because no counter placed a precedent; the HBase lead is unchecked, and it is in 16 of the 20 study rows (24 of the 31), COMP2 among them, so no order changes.

### 7.6 DEV-02 and the models

**COMP2's pairs, and where each sits** (computed here, `partners.py` and `ratios.py`). COMP2's 277 pairs are MIN-P's 252, which E-32 placed ([pairs.md] section 4), plus 25: the `memory` rung's 12 with MIN-P's units (E-32 placed them for COMP, with the same partners: 11 open under K-09 and K-05, 1 argued independent, with `forks`), and `par-repair`'s 13. Of those 13, 4 sit in E-37's model with `par`'s own rules (Raft's log, votes and commit, and the stand-down guard RF-02 counts; reasoned here, as E-37 holds those rules and E-32 had no `par` row to place); 9 are open (the journal, the tier, the disk incarnation, the dir lease, the recorder, the snapshot, the `memory` rung, the group config and the controller's commands; the last two are G-15's voter change).

| Row | Pairs | In an exhaustive model | In a simulation only | Argued independent | Open | Model or argument | Model, simulation or argument |
|---|---|---|---|---|---|---|---|
| COMP2 | 277 | 80 | 29 | 87 | 81 | 167 (60.3 %) | 196 (70.8 %) |
| COMP | 283 | 76 | 29 | 91 | 87 | 167 (59.0 %) | 196 (69.3 %) |
| MIN-P | 252 | 76 | 29 | 86 | 61 | 162 (64.3 %) | 191 (75.8 %) |
| SPLIT | 295 | 59 | 25 | 88 | 123 | 147 (49.8 %) | 172 (58.3 %) |
| DRAFT | 309 | 73 | 29 | 100 | 107 | 173 (56.0 %) | 202 (65.4 %) |
| PD | 218 | 44 | 21 | 78 | 75 | 122 (56.0 %) | 143 (65.6 %) |
| ISR | 214 | 16 | 20 | 96 | 82 | 112 (52.3 %) | 132 (61.7 %) |
| SLOG | 272 | 38 | 24 | 123 | 87 | 161 (59.2 %) | 185 (68.0 %) |

SPLIT's 17 merge pairs (RM-01) and PD's 9 link-ping pairs (RM-08) came after E-32 and are counted open here. E-32 did not place the pairs of TiKV's closure rows beyond PD's own.

- **DEV-02's MUST** (each pair inside one model or shown independent) is **open for every row**: every row has open pairs, and no model found a counterexample. **Its SHOULD** (at most 10 pairs) is **not met by any row**: the smallest is BUY's 12, and every v5 row that runs its own kernel carries 144 or more (V4 carries 52).
- **COMP2's open pairs** sit mostly where a mechanism was never built or modelled: the `memory` rung (K-09), `par` beside a voter change and the journal (G-15, K-24), hints (K-08), the slow-leader rule (K-17), quiet groups (K-22); the rest spread over about two dozen other closers ([pairs.md] sections 7 and 9).

**The composed model of the riskiest crossing** ([crossing/README.md]). It ran one slot move from group A to B, a leader change, a voter swap, a log drop behind a snapshot and the dedup state the move carries, in any order. Every property held on 28 bounds explored in full (up to 2,612,006 states each), and it found one counterexample neither single model could: in 6 steps, a write is both applied and told "refused". The fix is E-20's floor rule on one more path (the Raft thesis, section 6.3). It caught 95 of 136 mutants (70 %), under DEV-03's 85 %. It models leader healing and client sessions; it covers a controller row such as COMP2 only through a reduction a second agent checked: the controller changes a group's config only through the group's leader, under healing's own guards ([pairs.md] pairs 216 and 227; reasoned). Left out: the controller that heals and moves at once (K-07), the `memory` rung (K-09), `par` (G-15, K-24), a restore, writer time, the tier, many resources and 4,096 slots, hints, the slow-leader rule and quiet groups.

### 7.7 In short

Against rows nobody judged, the answer is settled among the options judged rows hold: on the strict reading no mix beats COMP2 without at least 4 guessed cells, and the best rows were judged blind. Four options no judged row holds could still beat it once tested and judged (section 4.7). Against its judged neighbours, COMP2's lead is thin: one model-checked SHOULD over COMP and MIN-P+m; 5 pairs over the separate-controller twin, which rest on family A's link-pings ruling; and a pair count from one agent's reads and writes. On the loose reading, rule 3 has no winner once one guessed cell is allowed. And the answer as a whole turns on one reading the user owns, DATA-01, with a pin COMP2 must keep on the strict side.

## 8. What the user must confirm

Items 1 to 14 are AMENDMENTS' list ("For the user to confirm"), in its order, with F_w, N_res, PERF-01 and the shared tier folded into the item that names them. Items 15 to 23 are the readings the referees and this page added. **Bold** marks an item that can change the winner.

| # | The question | In force now | The other way | What changes if the user picks the other way |
|---|---|---|---|---|
| 1 | F-06: may a leader's clock jump cause a failover? | no: writer time is the median of the members' clocks (A-23) | yes: CockroachDB's guard | no cell depends on it; no winner moves. Both need 7 rules; the guard failed over on every leader clock jump (60 of 60, [E-21]) |
| **2** | **PERF-01: which competitor-default rows may fero lose, by name?** | **none** | **JetStream's default single-publisher row (and PERF-02's and PERF-05's default rows)** | **strict: MIN-P+par (the `memory` rung goes); loose: TiKV-persisted. Neither rung has a winning number yet: E-02's `memory` rung read 0.57 ms in TS and 0.33 ms in Rust with no client hop, against a bar of about 0.30 ms at p99 and about 4,340 acks a second** |
| **3** | **Rule 3's order (REQUIREMENTS rule 4)** | **as written: the novel count first (when 2 apart), then SHOULDs, then pairs** | **SHOULDs first** | **strict: COMP2 either way. Loose: COMP2 (6 SHOULDs against TiKV-TS's 4), but only on three TiKV-TS SHOULDs nobody judged: P-22, DEV-05 and OPS-11 (S) are open for it, not "not met". If two came out met, the SHOULDs tie and the novel count picks TiKV-TS; with every open SHOULD counted met, TiKV-TS has 14 against COMP2's 13. So this is no independent support for COMP2. AMENDMENTS' "COMP follows rule 4" is out of date: `par-repair` is not novel (RM-03), so `par` joins under either order; a witness now costs pairs only (RM-02), and its DEP-15 (S) stays open, so it does not join** |
| 4 | DEP-17: may a platform hint change membership? | hints are inputs to the controller's loop, under A-20's re-checks | a hint changes membership directly | no cell depends on it; K-08's model is owed either way |
| **5** | **SC-03 and SC-10, and F_w** | **restated with the app split; F_w = 64** | **as worded; or F_w above 135** | **as worded: every row out (section 7.4). F_w above 135: the slot rows' own restated cells fail; split rows state no fixed ceiling, so SPLIT wins on the strict reading and TiKV-TS stays on the loose one (reasoned from the cells). At the 1,024-slot fallback a slot row states 72** |
| 6 | P-05: restate the delivery bar? | restated: a window per room and about 1,000 sockets a core | as worded | no winner moves: as worded P-05 is open, not failed, for all but OBJ and V4 (RR-02, RR-03). The choice sets the bar the build must meet |
| **7** | **F-17: restate, or add an election rule?** | **restated: "a connected majority that includes an up-to-date replica"** | **as worded; or a new election rule** | **as worded: every Raft row fails, every row is out (section 7.4). A new rule adds 1 novel mechanism to every Raft row alike, so no order among them changes. See item 19 for the reading of "connected majority"** |
| 8 | F-05's handover bar and SC-08 (b) | F-05 open either way (RR-01); SC-08 (b) restated | cut the slot move to one or two commits | no winner moves. The evidence: etcd misses 10 ms at the tail here, inside the disk's own stalls; one commit measured at most 4.7 ms, not yet modelled ([E-13]) |
| 9 | SC-13's "small", and N_res | "few slots touched"; N_res = 100,000 | per-slot state priced per touched slot; another N_res | no winner moves. An idle `pslot` resource is 0.4 to 1.2 KB at 1 to 10 touched slots; per-slot state is about 85 B a slot, so it passes 2 KB at about 20 touched slots and is about 8.5 KB at 100 ([E-36]; V-07) |
| 10 | P-09 and P-11 (D9): does "an empty take writes nothing" rule out "append every refusal"? | yes: `forward.once` | append every refusal (3 fewer rules) | no winner moves |
| **11** | **F-15: may a slot move wait while the object store is down?** | **yes (restated)** | **no** | **among judged rows: SPLIT (strict), TiKV-TS (loose), but SPLIT only because DRAFT's and SPLIT's restore mark has no home in the store yet. COMP2 with its mark's home left open the same way (S `jrnl +tier`) keeps 3 / 6 / 277 and passes, on 10 guessed cells (computed here, `s10.py`). So this item is mostly about where COMP2's mark lives, which nobody modelled** |
| 12 | A-23's agreement guard: when most clocks are wrong, stop or keep writing? | stop (9 rules) | keep writing by a wrong time (7 rules) | no winner moves; without the guard, 104 rows early, 370 late and 2 early lock grants in 30 runs ([E-21]) |
| 13 | SC-15: is 1.18 and 1.26 times against a 1.2 bar met? | open | met | no winner moves |
| 14 | J and a tier shared between projects (OPS-14) | yes, J says so | no | outcome B: no winner moves (COMP2, TiKV-TS). Outcome A: ISR alone first on the strict reading; ISR, PD+fix and TiKV-TS level on the loose one (31 rows) |
| **15** | **DATA-01: may a server fold rows in another engine once a test proves it equals data?** | **the cells follow the judges' "yes" (RR-07)** | **no: only data's own code folds on writers and followers (RR-10); or the middle reading, data's lane or a tested port of it** | **"yes": TiKV-TS (tied with its native twin). "No": COMP2, with the pin that its Rust core never folds rows (section 3.3). Middle: COMP2, no pin needed. BRIEF item 6 leans "no"** |
| **16** | **May a row with more open MUSTs outrank a better-tested one on counts alone?** | **yes: rule 3 never counts open MUSTs** | **a guard: open MUSTs counted first, or a cap** | **loose: COMP2 (98 open against 122). With the PERF-01 loss accepted: MIN-TS (95 open). Over the searched mixes: COMP2 in TypeScript for good (96 open, one guessed cell; section 5.1)** |
| **17** | **DEP-21's free bar: judged for a sleeping project, or also one awake all month?** | **asleep: DEP-21's first load is "a sleeping free project" (RR-09)** | **awake all month** | **MIN's shape (COMP2's family) costs $2.34, over by its volume's $0.15; SRV's $4.53 and PD's $6.72 are over too; DRAFT's family is at $2.19. No cell fails on price alone (RR-09). If a judge ruled the volume structural, COMP2's family and the separate-server shapes would go out and SPLIT would win (reasoned; V-05). At Fly's 730-hour month one always-on machine is about $2.22, so every row with one is about 1 % over** |
| 18 | DEP-21's place and price | J's first regions (iad, ams); subscribers inside; granular transfer rates | other regions; subscribers outside; no granular rates | no cell fails: DEP-21 stays open. COMP2's shape passes $10 at the top of its range in São Paulo, Johannesburg, Tokyo and Singapore or Sydney; subscribers outside who each get every write add $52.56 a month to every row ([E-41]) |
| **19** | **F-17's "connected majority": star (one server with two-way links to a majority) or clique (a majority in which every pair talks both ways)?** | **star (E-38's, the judges')** | **clique (RR-08)** | **outcome A only: the Raft rows' F-17 becomes open as worded, and DRAFT and SPLIT lead with 2 MUSTs (with PD+fix and TiKV-TS on the loose reading). The 2E clause waits on the sweeps re-run with CheckQuorum every E/4** |
| **20** | **The "other" readings: F-07 (is the two-voter window a stated limit or a failure?), P-02 and P-13 (are the expiry and presence bounds read by writer time?), DEV-01's bar (below v4's 13, while v4's settled count is 8), PERF-08's phase for OBJ, BUY and V4** | **the proposed readings** | **each read the other way** | **any of F-07, P-02 or P-13: every one-writer row fails it, every row is out, and the leading rows are level. DEV-01 and PERF-08: nothing moves** |
| 21 | Region scope (SC-14) | a group's voters in one region; writes homed in several regions are out of scope for v5 | writes homed in several regions | no cell moves now; SC-14 becomes WAN bars, and SPACE's R `epax` and O `hlc` come back |
| 22 | The fsync figure every latency bar is also stated against | a cited figure | another | no winner moves; E-01 could not prove this box's flushes reach the host's disk (G-22) |
| 23 | The mechanism close calls (MECHANISMS 4.5; RM-03 to RM-07; family A's mechanism rulings) | as settled | counter b's stricter counts; `dir-lease`'s HBase lead accepted; link pings not added to the separate-controller rows | no winner moves on the first two (section 7.5). Without family A's link-pings ruling (both judges), COMP+par C=cent V=full prices 272 and beats COMP2 by 5 pairs |

## 9. The next step

Settle the readings, write the models COMP2 rests on, then build the thinnest slice of COMP2 that runs end to end, break it under chaos, and time it with each rival's own tool. No further judging pass is owed on the strict reading among the options judged rows hold; a critic's lead that passes its experiment (step 3) owes one.

1. **Before code: the user's answers.** At least items 2, 5, 15 and 16, which can change the winner on their own (and item 3 on the loose reading). If the user picks the loose DATA-01 reading, rule 3 has no winner once one guessed cell is allowed (section 4.4). A judging pass is then owed on at least the two other rows of the cycle: TiKV's shape with client sessions and sagas (1 / 5 / 253, TiKV-TS's own twin of that kind included) and with a dedup window (2 / 5 / 252). The answer may still be a cycle, so the user should also say how one is broken. Also owed on that reading: family B's lead for the restore oracle after an unclean loss of the controller's majority (OPS-07; B.settled.json), and the referee's ruling on TiKV-TS's own DATA-01 cell (section 11).
2. **Before code: the models COMP2 rests on, judging-free.** (a) `par` with a voter change and on one journal per process (G-15, K-24). (b) Once step 6b's timing spike passes, the `memory` rung inside Raft when a majority stops uncleanly (K-09), with RR-11's saga rule in its refusal form (footnote 13 rules out the per-write form for COMP2) and the same question for lock fence tokens and session floors (P-10, F-02), by E-24's model rerun with a group that can lose its unsynced tail. (c) The controller that heals and moves slots at once, with `#meta` down or changing leader (K-07's controller form), and its 9 undecided mutants (G-09). And one model every slot row owes: (d) the slot move cut to one or two commits with its carried set (K-03, K-25), and the slot move's smallest TLA+ model re-run for DEV-10's mutants (G-07). *Closes, in part:* DEV-02, DEV-03, P-15, SC-08, F-12, F-22 (S).
3. **Before code: the critic's four experiments** (section 4.7): D `keys` on E-32's crossing, X `rampv` on E-24's RAMP model, Y `proxy`'s price (loose reading only), and R `vsr`'s costing. Each could reorder the top; none needs code. A lead whose experiment passes then needs a judging pass of the cells its axis decides (11 for D `keys`, 15 for X `ramp`, 72 for R `vsr`) and two counters ruling its novelty (DEV-10 (e)) before it can be named.
4. **The slice, in TypeScript.** E-10's port of etcd's Raft with A-01 and A-02; one controller loop on `#meta`'s leader that heals and moves, with A-20; one journal per process with its reserve, and a checksum per entry with `par`'s repair; `pslot` groups and a 4,096-slot table in `#meta`; one slot move with its carried set and one give-up decider; client sessions with `forward.once` and E-32's three rules; writer time as the median; the `persisted` rung; `data` folding the records, with a full projection on every full replica. That is MIN-P+par's shape. The `memory` rung comes as a spike on this slice (acknowledge when a majority holds the write in memory), timed in 6b; it stays, and is modelled (2b), only if it passes. Left out: the tier and restore, the `none` rung and relays, hints, the slow-leader rule, merged views. *Closes:* DATA-03, DATA-04, DEV-06, DEV-07, DEV-09, OPS-12 (their phase-1 parts), SC-01, SC-10's slot count.
5. **Chaos.** 1,000-seed sim sweeps with crashes, leader changes, voter swaps, a slot move, a log drop and one bad entry on each of two replicas; E-46's Maelstrom adapter with partitions and pauses (`--concurrency 2n`, an outside pauser, Porcupine beside Knossos); real Elle on the histories ([E-22b]); E-29's LazyFS power-loss tier; v4's stopsOneByOne harness; E-38's partial-partition seeds with CheckQuorum every E/4. *Closes:* P-01 (its safety half), F-06, F-07, F-09, F-16, F-17 (restated), F-21, DEP-02, DEP-03, TEST-09.
6. **Timing against the rivals, in the same hold.** PERF-01's rule: same box, at least 3 runs, median and spread, under the CPU lock, the floors measured first (`fio` fdatasync p99 and the loopback round trip). Through E-45's four gateways ([E-45]) and the competitor drivers of [E-09a2], [E-09b], [E-09c], [E-09d] and [E-09e]: (a) the PERF-08 pin; (b) `nats bench js` (PERF-04) on the `memory` rung's spike, the row that decides whether the rung stays (both bars in the kill table); (c) memtier through RESP (PERF-02); (d) etcd's `benchmark` through gRPC (PERF-07); (e) Kafka's own tools against Kafka and Redpanda (PERF-05, PERF-06). PERF-03 waits for the `none` rung.
7. **Failover and moves on three processes.** F-05's pins, the handover, the move's unwritable window, E-39 rerun with a server grant. *Closes:* F-05, SC-08's (b) pin, F-19, DEP-01, DEP-08.
8. **The native step** (`ts→rs`) for each row TS does not win: PERF-04's default row, PERF-08's native column, PERF-07's single client. If TS wins them all, stay in TypeScript (L `ts`, section 5.1). On the strict DATA-01 reading the Rust core orders, stores and ships records but never folds rows: records cross to `data` in JavaScript (X3's first way, E-03). The Rust core is still open: raft-rs 0.7.0 cannot run etcd's files (G-24). *Closes:* DATA-09 (by construction on the strict reading; by the differential test on the others), TEST-10 and those native columns.

**Kill criteria: results that would overturn this verdict.**

| Step | The result | The bar | What it overturns |
|---|---|---|---|
| 6b (first) | the `memory` rung's single-publisher result on `nats bench js`, one write in flight, client hop and gateway included | PERF-04 reports both msgs/s and p99 ack, and PERF-01's win is "median better by more than the larger spread". So: p99 below JetStream's 0.55 ms by more than 0.247 ms, about 0.30 ms; and at least about 4,340 acks a second (JetStream's 3,280 plus its spread of 2,287 to 3,342), a mean ack of about 0.23 ms or less. In TS or at the native step ([E-09b]; RR-04). The card's PERF-04 reason, which calls Rust's 0.33 ms "a win", predates RR-04's bar | if neither, COMP2 fails PERF-04 by measurement, as every row with the rung would; only a loss accepted by name then keeps a row in, and the arithmetic picks MIN-P+par (strict) or TiKV-persisted (loose) |
| 2b | the `memory` rung inside Raft breaks a MUST with no rule that fixes it (K-09, RR-11; P-10 and F-02 too) | none may | the rung goes: MIN-P+par's shape, which then needs the PERF-01 loss |
| 2a | `par` fails a MUST with a voter change or on one journal (G-15, K-24) | no counterexample | MIN-P+m (COMP2 with `rejoin`) |
| 2c | the controller model needs novel mechanisms that leader healing does not | fewer than 2, and fewer than 19 added pairs | COMP with `par` (leaders heal: 3 novel, 6 SHOULDs, 296 pairs) |
| 2, 5 | a counterexample where a slot move meets a membership change at two member faults (K-01) | none may | every slot row at once (AMENDMENTS G-01): COMP2, MIN-P and DRAFT alike |
| 2d | the slot move's mutants caught | ≥ 85 % (E-15: 39 %; the crossing: 70 %) | below it, DEV-03 fails for every slot row |
| 3 | D `keys` keeps F-02 beside fence tokens and fits DEP-13; or `rampv` holds read atomicity with one novel unit; or `vsr` costs fewer pairs | as the critic prices them | COMP2 with D `keys` (8 to 10 fewer pairs), with `rampv` (one more SHOULD) or with `vsr` (up to 10 fewer pairs), after a judging pass of their unjudged cells and a two-counter novelty ruling |
| 4 | the whole-resource cursor at 4,096 slots | ≤ Q-19's 8 KB (E-18 reasons about 32 KB) | fall back to 1,024 slots: 72 effective writers, still above 64 |
| 6a | p99 commit on the real kernel at 50,000 writes a second | ≤ C + 5 ms = 5.73 ms (TS) | over it, P-01 and PERF-08 fail in TS |
| 6c | memtier SET, matched | about 92,000 persisted SETs a second at 200 connections with p99 under 4.9 ms ([E-09a2]) | below it, PERF-02 fails |
| 6d | etcd one-client put | p99 under 1.73 ms ([E-09e]) | over it in TS and native, PERF-07 fails |
| 6e | Redpanda, matched | a TS build keeps at least 62 % of E-02's protocol-free ceiling ([E-09d]) | below it in TS and native, PERF-06 fails |
| 7 | failover after a writer's crash | p99 ≤ 2.5 s in TS. At E = 2 s with 0.25 E jitter the worst draw is the timer's 2.5 s plus about 5 to 20 ms to elect and acknowledge the first write, so E at about 1.98 s or less, or less jitter, keeps it under ([E-13], reasoned) | over it, F-05 fails for every Raft row alike |
| 7 | the move's unwritable window | ≤ 10 ms per move at p99 under 10,000 writes a second (three commits measured 16.7 ms, [E-13]) | if a one- or two-commit move still misses it, SC-08 fails for every slot row, unless (b) is restated |
| 7 | goodput at twice capacity | ≥ 80 % of peak (TS measured 79 to 82 %, [E-39]) | below it, F-19 fails in TS |
| sim, phase 4 | effective writers per resource with the real mover | ≥ F_w = 64 (E-18 predicts 135 at 4,096 slots) | below it, COMP2 fails SC-03 and SC-10 restated, and the split rows (SPLIT; TiKV's shape on the loose reading) are left |

## 10. How this draft was made, and what changed from draft 2

**Tools run for this draft,** from `docs/v5-space`: `python3 tools/closure_matrix.py` (prints the matrix; matrix.md unchanged), `python3 tools/closure.py check-all`, and `python3 tools/closure.py mechrow` for COMP with `par` and for COMP2. OUTCOME.md, the ladders and the cards were read as they stand (the ladders were rebuilt after RR-11 and RM-08, commit ceaf017).

**Scratch scripts** (in `/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad/verdict3/`; each imports `tools/closure.py` and, where it ranks, `tools/judging.py`'s `beats`; none writes a study file): `standings.py` (each row's tally, both outcomes, both DATA-01 readings), `comp2cells.py` (COMP2's open MUSTs, checked against draft 2's list), `partners.py` (the `memory` rung's and `par-repair`'s pairs), `sweep31.py` (OUTCOME's sweep over 31 rows), `aflips.py` (why OUTCOME A.3 flips), `keepone.py` (one clause kept as worded), `clique.py` (F-17's clique reading in outcome A), `beaters.py` (who beats COMP2 and TiKV-TS in the search, and on how many guesses), `seeds.py` (the hand-priced rows nobody judged), `hints.py` (planner hints on COMP2), `gaps.py` (every gap), `ratios.py` (DEP-21's ratios and the pair-placement shares).

**Revision after review** (the same day). Four skeptics tried to refute this draft (section 11). Each finding was checked here again before it changed the page: the tool's search was rerun on the four restated readings, with a shell of every mix within two axis changes of the 11 closure rows; rule 3 was applied pair by pair; the pair, cell and gap claims were recomputed; the critic's `critic/price.py` was rerun as it stands. Scripts in `/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad/v3-revise/` (each imports `tools/closure.py`; run from a scratch copy of `docs/v5-space`, or from `docs/v5-space`; none writes a study file): `dump.py` (the search plus the shell, per reading), `pairwise.py` (rule 3 pair by pair at each cap, beside the tool's shortcut), `beaters.py` (who beats COMP2 and TiKV-TS), `matrix_pw.py` (the matrix pair by pair; SHOULD counts), `st.py` (the shared tally), `celldiff.py` (cells that differ between rows), `pairs.py` (unit and pair differences), `a4a7.py` (dependence flags; the shared-tier flip as worded), `a5.py` (the attribution at commit 12defff against the 72 judged cells), `p10.py` (P-10 and F-02 opened on the `memory`-rung rows), `middle.py` (the middle DATA-01 reading; TEST-07 opened on M `kw` rows), `s3.py` (COMP2's language and host twins; open MUSTs first over the search), `s10.py` (F-15 kept as worded; COMP2 with its mark's home open), `worded.py` (rule 2 over unjudged mixes as worded), `rr04.py` (PERF-04's bound from E-01's table).

**What changed from draft 2.**
- **The question it left open is closed.** Draft 2 said rows nobody judged could rank above COMP2. The closure pass built about 379,000 mixes and judged the 11 best blind; on the strict reading no mix passes COMP2 without at least 4 guessed cells.
- **The answer now names the reading it depends on.** Draft 2 kept PD+fix out by asking to re-rule PD's DATA-01. The referee kept that cell open and made the reading the user's (RR-07, RR-10). So this draft gives both: COMP2 on the strict reading, which the brief supports; TiKV-TS on the loose one.
- **Numbers that moved.** COMP2: 274 → 277 pairs (RF-02, RF-03), 97 → 98 open MUSTs and 35 → 34 met (RR-11). Outcome A's top: ISR alone → DRAFT, SPLIT and ISR level (RR-01 to RR-03). SPLIT: 5 → 4 novel, 278 → 295 pairs (RM-01, RM-02). PERF-04's gap: 0.33 → 0.39 (RR-04), which the review showed is the top of a range from about 0.06 (section 2). Two-verdict cells: 189 → 169.
- **Draft 2's rivals.** PD+fix is judged (122 open, out on the strict reading). SPLIT2 is 273 pairs as described (269 with N `proc`), on 16 guessed cells.
- **The recheck's findings (V-01 to V-18)** are applied where they still bear: V-01 and V-02 in section 4.6; V-03 in section 6 (RR-06); V-04, V-05 and V-06 in sections 6 and 8 (items 17, 18); V-07 in item 9; V-08 in section 7.4; V-09 in sections 3.2 and 7.5 (the C margin is 19 pairs, or 3 with hints counted on both; a tie would need 19 more on COMP2 and a flip 20); V-10 in section 7.6's two placement columns; V-11 in section 2; V-12 in section 4.8; V-13 in section 6; V-14 in sections 0 and 9 (three models COMP2 rests on, plus one every slot row owes); V-15 in section 5.4; V-16 in section 1; V-17 by RR-04, which three agents computed (E-01's 481 µs is its per-run median p99; the pooled table's p99 is 539 µs); V-18 in section 7.5.
- **Draft 2's section 10** (the first skeptics' findings and its re-rule table) is answered by the re-rulings of section 7.2; the findings themselves stay in [VERDICT.review.json](judging/VERDICT.review.json).

## 11. What the skeptics said

Four skeptics read draft 3, each through one lens, and tried to refute it. Every finding below was checked again here (section 10 names the scripts). No judging file was changed.

### 11.1 Did the verdict survive each lens?

- **The arithmetic.** It survived. The skeptic reran every tool on a copy and got the repo's files byte for byte; this revision reran the search and got the same counts and the same winners. What did not survive were claims about why and how surely: the 5-pair lead over the separate-controller twin rests on one ruling, and rule 3 cycles where the ladders print a winner. Both are fixed.
- **The evidence under the deciding cells.** It survived. Under the readings the page argues, every winner stays. The strict reading needed a pin on COMP2's own Rust step, RR-11's reason reaches P-10 and F-02, and PERF-04's gap is a range. None moves a matrix line.
- **The strongest case for a different answer.** It survived on the page's own frame (strict DATA-01, clauses restated, no loss accepted). The skeptic's main point stands and is now said first: on the cells as settled, the rule names TiKV-TS. The critic's four leads remain live threats until tested and judged.
- **Independent derivation.** It reached the same answer. Working from the files before reading this page, it got the same arithmetic on every matrix line: TiKV-TS on the cells as settled, COMP2 (tied with COMP2 V=full) on the strict reading, TiKV-persisted or MIN-P+par with the loss. It leaned to the strict reading on its own, for the same reasons plus SPACE's G6 note on PD. Its differences were framing and the ladder's cycles, not the winner.

### 11.2 Each finding

| Id | What it said | Outcome |
|---|---|---|
| A1 | The 5 pairs between COMP2 and COMP+par C=cent V=full are controller sessions, not link pings; without family A's link-pings ruling that twin (272) beats COMP2 | Holds (`pairs.py`). Fixed in 0, 3.2, 6, 7.5, 7.7 and item 23 |
| A2 | On the loose reading rule 3 cycles from one guessed cell, so the "best member" and the single owed pass are not well founded | Holds (`pairwise.py`: no unbeaten row from 1 to 148). Fixed in 0, 4.4 and 9 step 1 |
| A3 | The strict ladder's "first by rule 3" from 5 up is the tool's shortcut and is beaten pair by pair; 4 is skipped | Holds: COMP2 at 0 to 3, COMP2 D=win S=jrnl +tier at 4, a cycle from 5. Fixed in 4.4; the tool fix is listed in 11.3 |
| A4 | With no shared tier, "ISR alone first" holds over 31 rows on the strict reading only | Holds (`a4a7.py`). Fixed in 7.3 and item 14 |
| A5 | Only 3,032 cells are a real test; 1,556 are the model's own predictions; it predicted 63 of the 72 judged cells beforehand; all overrides are V4's | Holds (`a5.py`). Fixed in 1 and 4.2 |
| A6 | Four P-15 crossing cells were raised by judge 2 alone, so "agreed on every cell" needs a qualifier | Holds (B.settled.json). Fixed in 4.5 and 7.1 |
| A7 | The sweep's F_w and F-06 lines test nothing on the slot rows | Holds: F_w flags only CELL's OPS-01; no cell depends on F-06. Fixed in 7.4 |
| A8 | RR-11 re-ruled four study rows, and the `memory` rung costs a met MUST rather than buying none | Holds (`celldiff.py`: COMP2 against MIN-P+par differs on P-15 M and PERF-04 only). Fixed in 3.2 and 7.2 |
| A9 | Learners add 8 pairs today (7 when ruled); `dir-lease` is in 16 study rows, 24 of 31 | Holds (`pairs.py`). Fixed in 4.5 and 7.5 |
| A10 | The search never walks out from the 11 closure rows | Holds. A shell of about 21,500 mixes per reading finds no strict beater under 4 guessed cells and one more loose one-guess beater. Fixed in 0, 4.3 and 4.4 |
| F1 | The strict reading as stated fails SRV against X3, catches COMP2's own Rust core and compact rows read word for word, and TiKV-persisted carries SRV's reason | Partly fixed. The referee's own framing fails SRV (RR-10's user choice) and SPACE lists a native server fold as a G6 risk, so the strict reading stays as framed. F1's reading is added as the middle reading (same winners, `middle.py`). COMP2's pin is stated in 0, 3.3, 5.1, 5.4 and 9. TiKV-persisted's reason is in 11.3 |
| F2 | RR-11's reason also reaches P-10 and F-02 | Holds as a gap (K-09 names both). Not re-ruled here; stated in 4.8, 5.2, 5.3 and 9, and listed in 11.3 with its effect (99 or 100 open; no line moves) |
| F3 | RR-11's "commit at `persisted`" half contradicts COMP2's per-resource rungs | Holds (footnote 13). Fixed in 5.3, 5.4 and 9 step 2: for COMP2 the closer is refusal |
| F4 | PERF-04's gap is 0.06 to 0.39, not 0.39 | Holds (`rr04.py`: 0.40, 0.23 and 0.07 by how the round trip is counted). Fixed in 2, 3.1 and 7.2; the recorded gap is in 11.3 |
| F5 | The separate-controller rows' extra 5 pairs come from controller sessions | Holds; the same as A1. Fixed with A1 |
| F6 | `par`'s "7 rules, each needed" leaves out the append guard, the END read rule and the mutant score | Holds (E-37, A.settled.json). Fixed in 5.1 and 5.3 |
| F7 | P-10, F-02 and TEST-07 inherit their supporters' gaps, which no judge looked at | Holds. Fixed in 4.8; listed in 11.3 (TEST-07 opened on every M `kw` row moves no line, `middle.py`) |
| F8 | The first kill test needs a msgs/s bar too; the card's PERF-04 reason predates RR-04 | Holds (PERF-01's win is on the median; PERF-04 reports msgs/s). Fixed in 0, 5.2 and the kill table |
| S1 | The headline uses a DATA-01 reading that is not in force | Holds. Fixed in 0 item 1, 1 and 3.3 |
| S2 | The strict reading is applied to TiKV's shape while COMP2 keeps the loose reading's closer for its Rust step | Holds. Fixed by the pin and the DATA-09 closer (0, 3.3, 5.1, 5.4, 9 step 8) |
| S3 | Over the search, open MUSTs first picks COMP2 in TypeScript for good | Holds (`s3.py`: 3 / 6 / 277, 96 open, one guessed cell). Fixed in 3.2, 5.1 and item 16 |
| S4 | SHOULDs first on the loose reading rests on three TiKV-TS SHOULDs nobody judged | Holds (14 against 13 with every open SHOULD met). Section 0 no longer cites it; item 3 and 7.4 say so |
| S5 | The ladders' "first by rule 3" is not rule 3 where it cycles | Holds; the same as A3. Fixed with A3 |
| S6 | The loose reading's "best member" sits in a three-way cycle | Holds; the same as A2. Fixed with A2 |
| S7 | "No more judging" clashes with the critic's leads, each of which would beat COMP2 | Holds (`price.py` rerun). Fixed in 0, 4.7, 7.7, 9 and the kill table: "settled among held options" |
| S8 | `vsr` is up to 10 fewer pairs, not 7 | Holds (267 against 277; 259 with D `keys`). Fixed in 4.7 |
| S9 | The `memory` rung's "open" PERF-04 rests on a basis written before RR-04; build without the rung first | Holds. Fixed in 0, 5.2 and 9 (steps 2, 4, 6): the rung is a gated spike. The basis is in 11.3 |
| S10 | Item 5 also changes the winner; item 11 is mostly where COMP2's restore mark lives | Holds (`s10.py`). Fixed in 0 item 4, 9 step 1 and item 11 |
| S11 | Add the grounds a reasonable engineer would weigh beyond DATA-01 | Holds (34 against 10 met; E-44's lines; U `cli`; cost; DATA-03). Fixed in 0 item 3 and 3.3, with the oracle caveat |
| S12 | The strict definition's words are wider than the tool's encoding | Holds. Fixed in 1 and 3.3; listed in 11.3 |
| I-1 | Make the answer conditional in its first words; cite SPACE's G6 note on PD | Holds. Fixed in 0 item 1, 1 and 3.3 |
| I-2 | TiKV-TS's loose DATA-01 cell borrows a native-fold reason, though its TypeScript phase is not native | Plausible; a referee's call, not ruled here. Stated in 3.2 and item 15; listed in 11.3 (its native twin ties it at 0 / 4 / 244 with no guessed cell) |
| I-3 | The ladder's shortcut is not rule 3 above 0 (loose) and 3 (strict) | Holds; the same as A3. Fixed with A3 |
| I-4 | A sixth one-guess beater of TiKV-TS is missed, and one judging pass cannot settle a cycle | Holds (the shell finds it). Fixed in 4.3, 4.4 and 9 step 1 |
| I-5 | Outcome A is not closed against unjudged mixes | Holds (`worded.py`: 16 loose, 13 strict, each on 8 to 21 guessed cells). Fixed in 2 |
| I-6 | The headline should name the twins that tie COMP2 | Holds. Fixed in 0 item 2 |
| I-7 | On the strict reading COMP2's Rust core must not fold | Holds; the same as S2. Fixed with S2 |

### 11.3 Cells and records to re-rule

None of these files were edited here. The effects were computed on scratch copies with the study's own code.

| # | Cell or record | Evidence | Effect on the matrix |
|---|---|---|---|
| 1 | P-10 (M), and F-02 (M) where met, for the rows with the `memory` rung: DRAFT, CELL, SPLIT and COMP, and through the attribution MIN-P+m, COMP2, COMP2 V=full and COMP+par C=cent V=full | AMENDMENTS K-09 names "lock fence tokens, session floors" in the tail a majority's unclean stop loses; RR-11's second path is a fence table going back (E-24); P-10 asks tokens to rise strictly across failovers. Same reason as RR-11, not ruled for these cells | No line moves (`p10.py`). P-10 alone: COMP2, COMP and MIN-P+m 99 open, DRAFT 100, SPLIT 102. With F-02 too: COMP2 100 open, 32 met |
| 2 | RR-11's closer, for rows whose rungs are set per resource (COMP and COMP2's family) | AMENDMENTS 4 footnote 13: "never per write, because G `pslot` cuts groups by durability". Only the refusal half is open to them | None on cells; it narrows what P-15 offers |
| 3 | RR-04's PERF-04 gap (0.39) | 0.39 adds the round trip's p99 as a constant; the median round trip gives 0.23, no network about 0.06 (`rr04.py`) | No winner. Outcome A places 16 and 17: PD passes CELL if the gap is under about 0.22 |
| 4 | The Q `mix` rule of PERF-04 in attrib/PERF-DATA.json (and its copy in the cards) | Its basis calls Rust's 0.33 ms "a win", written against 0.55 ms, before RR-04's 0.303 ms bar | None: the cell stays open (no one-in-flight run; one working point is no ceiling), but its reason should say so |
| 5 | DATA-01's strict encoding in attrib/PERF-DATA.json | (a) TiKV-persisted fails through SRV's rule (F `all(srv)`) and carries SRV's reason, though its engine is PD's. (b) The rules read F, K and S only, so rows with K `lib` and an LSM, and H `srv` rows after a Rust core, escape. (c) COMP2's pin (its Rust core never folds; a full data projection on every full replica) is not recorded | (a) none. (b) none on the 31 rows (none has K `lib` with an LSM); the strict ladder's H `srv` twins of COMP2 would need the same pin. (c) if a referee records the pin, COMP2's DATA-09 holds by construction: 98 → 97 open |
| 6 | DATA-01 (M) for TiKV-TS on the loose reading | Its TypeScript phase folds in a multi-version LSM written in TS, neither data nor native code; DATA-09 speaks of a layer that "moves to native code" | If it failed, the loose leader would be its native twin, PD+fix with forwarding, `kw` threads and `par` (0 / 4 / 244, no guessed cell, not judged); the loss lines do not move |
| 7 | TEST-07 (M) for the 21 rows with M `kw` where it is met | The state that judges a write includes the kernel worker's compact rows and tables (A-27, E-05), the ground family B used to open TEST-07 for TiKV-TS; COMP2's support (E-06) undoes only data's records | No line moves (`middle.py`) |
| 8 | `tools/closure.py`'s `unbeaten()` and the ladder files built from it | It is a window shortcut, not rule 3 pair by pair, so it prints a beaten row where rule 3 cycles; the ladders skip 4 guessed cells; the search does not seed from the 11 closure rows. Fix: use judging.py's pairwise rule and report "none (a cycle)", add cap 4 and the 11 rows as seeds, rerun `closure_ladders.py` and `closure_matrix.py` | The matrix stays as it is (each line is clean pair by pair). The strict ladder becomes COMP2 at 0 to 3, COMP2 D=win S=jrnl +tier at 4, a cycle from 5; the loose ladder becomes TiKV's shape at 0, a cycle from 1. The PERF-01-loss ladders keep their winners at every cap (the shortcut's pick is unbeaten there) |

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
[E-10]: experiments/E10-raft-port/README.md
[E-13]: experiments/E13-handover/README.md
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
[E-36]: experiments/E36-many-resources/README.md
[E-37]: experiments/E37-bad-entry/README.md
[E-38]: experiments/E38-raft-gray-failures/README.md
[E-39]: experiments/E39-overload-storm/README.md
[E-41]: experiments/E41-hosted-cost/README.md
[E-44]: experiments/E44-outside-log/README.md
[E-45]: experiments/E45-drivers/README.md
