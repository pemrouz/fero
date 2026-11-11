# The v5 verdict

Final, 2026-11-11, for the v5 design-space study ([BRIEF.md](BRIEF.md)). It is draft 3 of the same day, brought up to date.

- Draft 2 (2026-11-10) named COMP2 but called itself "not final", because rows nobody had judged could rank above it.
- A **closure pass** then searched the space between the judged rows and judged the best of them blind ([judging/closure/README.md](judging/closure/README.md)). Draft 3 read that work.
- Four skeptics and then a fresh reader tried to refute draft 3 (section 11). A referee ruled on its re-rule list (RR-12 to RR-19). The search tool was fixed, and the ladders were rebuilt. A last fresh reader then checked the page against the files, and its ten findings are applied (section 11.4). This final page reads all of that.

Every number here comes from a file or a tool, and the text says which. "Computed here" means a scratch script that only calls the study's own code: `tools/closure.py`'s cell model, tally and pair rule, and `tools/judging.py`'s rule 3. Section 10 names each script. This page changed no judging file.

## Key of terms

- **Row:** one whole design, made of one option on each of 22 **axes** (design questions, such as R, how replicas agree). A name like "COMP2 V=full" means row COMP2 with axis V set to `full`. A **twin** is such a variant that ties its row on rule 3's counts. A line of a benchmark's results is called a **test line**, never a row.
- **Cell:** one requirement part, judged for one row.
- **MUST and SHOULD:** the two kinds of requirement part. A MUST is **met**, **open** (not shown either way) or **fails** (shown by proof). A SHOULD is met, not met, or open.
- **Mechanism:** one named piece of durable or replicated state, plus the rules that write it. It is **novel** when no paper or production system has the same state and rules in the same role.
- **Interacting pair:** two mechanisms of one row that touch the same state, at least one of them writing it. Fewer pairs means less to get wrong.
- **Rung:** what a commit means. `persisted` is on disk at a majority, `memory` is in memory at a majority, and `none` is best effort.
- **Group:** one Raft log with one leader. **Slot:** a fixed share of a resource's keys. A **slot move** takes a slot from one group to another.
- **Fold:** turning the log's change records into rows, the current state. `data` is fero's state engine, the library that folds.
- **`#meta`:** the project's own system group. It holds the members, the catalogue and the slot table.
- **TiKV's shape:** the design of TiKV, an open-source distributed key-value store. Its groups split and merge by size. A placement process (PD) moves them, and a timestamp oracle hands out times. Writes across groups use two-phase commit (all prepare, then all commit). Servers keep many versions of each row in an LSM (a disk store that writes sorted batches). The rows PD, PD+fix, TiKV-TS and TiKV-persisted have this shape.
- **Restore mark:** a small record in the object store's manifest: an epoch high-water mark and a session generation. It keeps epochs and sessions from going back after a restore.
- **Witness (log replica):** a replica that keeps the log but not the rows.
- **p99:** the time that 99 of 100 operations beat.
- **Guessed cell:** a predicted cell that no judged row backs. The files say "unsupported".
- **Axis letters and options:** COMP2's 22 axes and the option it takes on each (such as F `all(srv)`, K `kern`, M `kw`, H `srv`, D `win`, S `jrnl +tier`, L `ts→rs`) are listed in plain words in section 5.1. [SPACE.md](SPACE.md) section 2 lists every option.
- **`par` and `rejoin`** (axis Z): two ways to handle a damaged log entry. `par` repairs it from a peer (protocol-aware recovery, PAR). `rejoin` wipes the damaged replica, which then rejoins as new.
- **Mix, seed, frontier, family:** a **mix** is an unjudged row the search builds from options judged rows hold. A **seed** is a row the search starts from: every judged row plus seven built by hand. The **frontier** rows are the best mixes, which the closure pass then judged blind. A **family** is the set of frontier rows one pair of judges scored (A or B).
- **The rows built by hand:**
  - COMP2 is COMP (the study's composite) with the controller loop on `#meta`'s leader (C `cent-co`) and `par`.
  - MIN-P+m is COMP with the controller loop: COMP2 with `rejoin` in place of `par`. MIN-P+par is MIN-P with `par`: COMP2 without the `memory` rung.
  - COMP+par is COMP with `par`. "COMP+par C=cent V=full" is its twin with a separate controller process (C `cent`) and every replica a voter: the "separate-controller twin".
  - SPLIT2 is SPLIT with client sessions, the controller loop, learners, split and merge, and `par`. H2 is COMP with the controller loop, split and merge, and an offset per group with lineage (O `off+lin`). PD+fix is PD with `rejoin`, an LSM with the tier, and the rung mix.
- **Layers L0 to L5:** DESIGN-V5's stack. L0 storage and I/O, L1 the log (Raft), L2 the fold and ops, L3 flow, L4 the surface, L5 libraries.
- **E:** the election timeout. "CheckQuorum every E/4" means a leader checks every quarter of it that a majority still hears it.
- **Override:** a cell the closure model cannot derive from a row's tags, so it is copied from the judged cell.
- **Plain technical words:** an **ack** is the reply that a write is committed. **fsync** forces written data onto the disk. **RSS** is the memory a process holds. **ReadIndex** is Raft's way to serve a read without writing to the log.
- **Test tools named on this page:** TLC checks TLA+ models by trying every state. Maelstrom (from Jepsen) runs a node against a simulated network with faults. Elle (from Jepsen) checks a history of transactions for anomalies. Knossos and Porcupine check that a history is linearizable.
- **Design rule:** a rule a row promises to keep, recorded by a referee. The files store these under the key `pins`. On this page a **pin** is something else: a timed test kept in the perf suite, as in fero's own repo.
- **The study's labels:**
  - A-nn is a fix in AMENDMENTS section 1. K-nn is a crossing in AMENDMENTS section 4 (mechanisms no experiment ran together). G-nn is a gap in AMENDMENTS section 5.
  - RR-nn, RM-nn and RF-nn are a referee's re-rulings: of a cell, of a mechanism's count, and of a mechanism's record.
  - E-nn is an experiment in [experiments/](experiments). Q-nn is a question in [QUESTIONS.md](QUESTIONS.md). X3 is a conflict in REQUIREMENTS section 10.
  - J is "fero deploy: the journey", a source REQUIREMENTS cites. Decision 13 is DESIGN-V5's choice to run the TypeScript kernel on a worker thread.
  - V-nn are findings on draft 2 ([VERDICT.review.json](judging/VERDICT.review.json)). A1 to A10, F1 to F8, S1 to S12, I-1 to I-7 and R1 to R14 are findings on draft 3 ([VERDICT.review3.json](judging/VERDICT.review3.json)). In the closure files, A1 to A8 and B1 to B3 name family A's and family B's rows.

## 0. The answer

1. **Aim for COMP2: build MIN-P+par's shape first, and add the `memory` rung only if it passes its kill test** (6b in section 9). MIN-P+par is COMP2 without that rung.
2. **COMP2 in short:** Raft groups owned by the project hold fixed slots of many resources. One loop on `#meta`'s leader heals replicas and moves slots. `data` folds the rows on every full replica (section 5.1).
3. **It wins on the strict reading of DATA-01:** only `data`'s own code folds rows on writers and followers. Its score there: 3 novel mechanisms, 6 SHOULDs met, 277 pairs, no MUST failed, 99 open ([matrix.md](judging/closure/results/matrix.md)).
4. **The brief supports that reading.** BRIEF item 6 says "`data` stays the state engine". SPACE says `data` is not the engine on PD's servers (section 3.3).
5. **The cells as settled follow the loose reading:** a server may fold in another engine once a test proves it equals `data`. Read so, rule 3 names TiKV's shape: TiKV-TS, with 0 novel, 4 SHOULDs, 244 pairs and 122 MUSTs open.
6. **Why the page does not stop there.** TiKV-TS has 23 more open MUSTs than COMP2, and 10 MUSTs met against 33, because no experiment ran its shape. Rule 3 never counts that. And on that reading, once one guessed cell is allowed, rule 3 goes round in a circle, except at 10 and 11 guessed cells, where a row resting on 10 guesses is unbeaten (section 4.4).
7. **User choices that change it** (bold in section 8, in one list under its table): the loose DATA-01 reading gives TiKV-TS (item 15). Accepting JetStream's default test line as a loss gives MIN-P+par (item 2). F_w above 135, F-15 kept as worded, or DEP-21's volume ruled structural gives SPLIT (items 5, 11, 17).
8. **How sure:** settled among the options some judged row holds. On the strict reading, of 381,087 searched mixes, none with 3 or fewer guessed cells beats COMP2 (section 4). Three options no judged row holds could still beat it, once tested and judged (section 4.7).
9. **The lead is thin** against its judged neighbours: one judged SHOULD (F-22 S) over COMP and MIN-P+m, and 5 pairs over a twin with a separate controller (section 7.5).
10. **Three things it rests on were never modelled** (section 9 step 2): `par` with a voter change, the `memory` rung inside Raft, and the controller healing while it moves slots.
11. **Next step:** no more judging among held options on this reading. Write those models. Then build MIN-P+par's shape in TypeScript, break it under chaos, and time it with each rival's own tool (section 9).
12. **The rung's kill test:** with one write in flight, p99 under about 0.30 ms and at least about 4,340 acks a second. JetStream's default gets p99 0.55 ms and 3,280 a second ([E-09b]; RR-04; PERF-01's spread rule).

## 1. The question and the rule

**What was compared.** 31 rows are judged, each a design on the 22 axes of [SPACE.md](SPACE.md) section 2 (for example R, how replicas agree, or Q, what a commit means).
- Twenty come from the first judging. Nineteen are SPACE's named designs, as AMENDMENTS sections 1 and 3 fixed them. The twentieth is **COMP**, the composite that takes AMENDMENTS' favoured option on each axis.
- The closure pass judged eleven more (section 4). Its judges scored 72 cells: the 66 cells no judged row supported, and 6 cells they opened on crossings. They also checked each row's mechanism list. The other 1,556 cells of those rows are predictions from the judged rows (section 4.2).
- All were judged against the 140 requirements of [REQUIREMENTS.md](REQUIREMENTS.md): 148 parts, 132 of them MUST and 16 SHOULD. So there are 148 × 31 = 4,588 cells.

**More words used below.**
- Novelty follows DEV-10. DEV-01 counts novel mechanisms per row, and DEV-02 counts interacting pairs. The counts come from code ([judging/PAIRS.md](judging/PAIRS.md), `tools/closure.py`).
- **C** is the study's commit bar: the three-writer fsync p99 plus the round-trip p99, 0.73 ms on this box ([E-01]). It is a sum of two p99s, not a floor.
- **F_w** is the number of effective writers per resource a row must reach (64 now). **N_res** is the number of resources per project (100,000 now).
- **Re-rulings.** RR-nn rulings are in [rerulings.cells.json](judging/closure/rerulings.cells.json). RM-nn and RF-nn rulings are in [rerulings.mech.json](judging/closure/rerulings.mech.json). Both tools apply them.
- **The closure pass's words.**
  - The **attribution** says, for each requirement part, which axes decide its cell.
  - A predicted cell is **supported** when a judged row shares its options on every deciding axis. It is **guessed** when none does.
  - A **ladder** ranks rows as more guessed cells are allowed. The **matrix** gives the winner under each set of the user's open choices.
- **DATA-01, loose, strict and middle.** DATA-01 says data's hot lane folds the rows "the same on writers, followers, clients and replays".
  - The **loose** reading is the judges' and is in force. A server may fold rows in another engine once a differential test proves the result equals data's (DATA-09's path).
  - The **strict** reading is the referee's framing (RR-10), written out in RR-17. Only data's own code folds the rows on writers and followers. A row fails it when its own tags put the rows in another engine. That is servers that fold in Rust or Go (F `all(srv)`), or a kernel that writes the rows into its own LSM (K `kern` with an LSM). So SRV and PD's family fail it.
  - The **middle** reading allows data's lane, or a port of it proven by DATA-09's test, and no other engine. It fails PD's family only, and it gives the same winners as the strict one (section 3.3).
- A **circle** (a cycle) is when rule 3 goes round: A beats B, B beats C, and C beats A. Then no row beats all the others. It can happen because two rows tie on the novel count whenever they are fewer than 2 apart (section 4.4).

**The judging rule** (REQUIREMENTS, "Judging rule"), in plain words:
1. A row **fails** a MUST only on proof. The proof is a counterexample in a model of its own mechanism, a measured ceiling below the bar, or a structural argument a second agent confirms in writing. Otherwise the MUST is **open**.
2. A row that fails a MUST is **out**. If every row is out, rank them by how many MUSTs each fails. Break ties by the sum of gap ÷ bar over those MUSTs.
3. Among the rows still in: if two rows' counts of novel mechanisms differ by 2 or more, the lower count wins. Otherwise the row that meets more SHOULDs wins. If still level, fewer interacting pairs wins.
4. (For the user to confirm.) Rule 3 ranks few novel mechanisms above the SHOULD count.

**What the rule does not look at.** Rules 2 and 3 never count open MUSTs, and never count rules. So a row with less evidence can rank above a row with more. This decides more than one line below.

**Why two outcomes.** AMENDMENTS section 1.3 lists clauses that the evidence shows no row meets as worded. It also says what each experiment asks instead. The wording is the user's, so 169 cells of the 20 study rows carry two verdicts ([OUTCOME.md](judging/OUTCOME.md)).
- **Outcome A** uses the requirements as written.
- **Outcome B** uses the clauses restated as section 1.3 asks.

**How the cells were judged.**
- The requirements were split into seven groups. Two judges scored each group without seeing each other's work.
- A referee ruled in writing on every one of the 330 cells where they differed (73 of them decisive). The referee never ruled against both judges. Code did the arithmetic.
- Two blind counters counted the mechanisms, and a referee settled their differences ([MECHANISMS.md](MECHANISMS.md)).
- After draft 2, a referee re-ruled 54 cells and part of the mechanism list (section 7.2). The closure pass then had 72 more cells scored by two more blind judges per family, and a referee (section 4.5).
- After draft 3, a referee ruled on its re-rule list (RR-12 to RR-19, section 11.3). [OUTCOME.md](judging/OUTCOME.md) now says a referee re-ruled 64 cells in all.

**The user's numbers in force.** Until the user answers, REQUIREMENTS' proposed values apply:
- F_w = 64 writers per resource, and N_res = 100,000 resources per project.
- No competitor-default loss is accepted.
- A group's voters sit in one region. **Writes homed in several regions are out of scope for v5** (SC-14 asks this page to say so).
- A tier shared between projects is allowed (J changes).
- Every latency bar is also stated against a cited fsync figure.
- Rule 3 applies in the order written.
- DEP-21's free bar is judged for a sleeping project (RR-09).
- The settled cells follow the judges' loose reading of DATA-01 (RR-07). The referee named the strict reading as the user's choice (RR-10) and wrote it out (RR-17).

This page gives the winner under both DATA-01 readings and names COMP2 on the strict one. That is the one place where this page departs from a reading in force. By the cells as they stand, rule 3 names TiKV-TS. Section 3.3 says why the page leans the other way.

## 2. Outcome A: the requirements as worded

**The result.** Every row fails at least one MUST, so rule 2 ranks them. Among the 20 study rows, DRAFT, SPLIT and ISR are level first ([OUTCOME.md](judging/OUTCOME.md) A.2).

The table names these MUSTs by number: F-17 (Partial partitions), SC-03 (Scale writes up), SC-04 (Scale down), SC-10 (Only stated ceilings, each above its floor), F-15 (Outside services) and PERF-04 (NATS JetStream). DATA-01 (data is the state engine) joins them only for the closure rows on the strict reading, below.

| Place | Row | MUSTs failed | Gap ÷ bar, summed |
|---|---|---|---|
| 1 | DRAFT | F-17, SC-03, SC-10 | 1.32 |
| 1 | SPLIT | F-17, SC-03, SC-10 | 1.32 |
| 1 | ISR | SC-03, SC-04, SC-10 | 1.32 |
| 4 | COMP | F-15, F-17, SC-03, SC-10 | 1.32 |
| 5 | SRV, SLOG, RLOG, EMB-V8 | 4 each | 1.39 |
| 9 | MIN, RUST, LEAN, LANE, MIN-P, MIN-TS, SIDE | 5 each | 1.39 |
| 16 to 20 | PD (6), CELL (6), OBJ (9), BUY (27), V4 (50) | in brackets | 1.39, 1.54, 18.08, 8.79, 10.04 |

**The closure rows as worded** (computed here, `standings.py`):
- COMP2, COMP2 V=full, MIN-P+m and COMP+par C=cent V=full fail what COMP fails (4 MUSTs, 1.32).
- The three MIN-P+par rows fail those and PERF-04 (5, 1.39).
- SRV V=full Y=fwd and TiKV-persisted fail 4 (1.39).
- PD+fix and TiKV-TS fail F-17, SC-03 and SC-10 (3, 1.32). So on the loose DATA-01 reading they share first place. On the strict reading they also fail DATA-01 (4).
- The matrix's as-worded lines say the same.

**Unjudged mixes as worded.** The closure pass ranks outcome B only. As worded, a search of 109,952 mixes finds 20 on the loose reading, and 17 on the strict, that fail exactly SC-03 and SC-10 (computed here, `worded.py`; rechecked by the fresh reader). That is one MUST fewer than any judged row.
- 16 of them (13 on the strict reading) fail only cells some judged row supports. They carry 8 to 21 guessed cells. P-01 is among them on every row, and P-02 on all but four.
- The other 4 fail SC-10 only on a guess: ISR P=slot O=hlc, ISR P=slot O=slot, SLOG Q=mix S=walg and SLOG Q=mix S=walg +tier. The search counts a fail only when a judged row supports it, so by its own rule these four fail only SC-03: two MUSTs fewer than any judged row.
- By kind: 11 are ISR with another partition map, 6 are SLOG with the `memory` rung, and 3 (loose reading only) are PD+fix with ISR's replication.
- So outcome A's first places are not closed against unjudged mixes. Outcome A names nothing to build either way.

**What changed since draft 2.** Three re-rulings took two failures off every Raft row.
- RR-01: F-05's handover clause as worded is open, not failed. E-13 measured etcd's own server on this disk, which is no ceiling for a port.
- RR-02 and RR-03: P-05's delivery bar as worded is open. E-08's p99 was one prototype's working point at about half a core, not a floor.
- So first place went from ISR alone to three rows level.

**What it means.**
- **Rule 2 counts only failures that are proven.** A MUST nobody tested stays open and costs nothing. ISR is level first with DRAFT and SPLIT because its F-17 was never run. E-38 ran etcd's Raft, not ISR, SLOG, OBJ or V4 ([ISR scorecard](judging/rows/ISR.md)). So, as worded, the order mostly shows how much of each row was tested.
- **SC-04 is failed by ISR and LANE only.** ISR's partition count is fixed when a resource is made, and nothing merges a group. LANE has no rule that removes a lane (structural). ISR still fails SC-03, SC-04 and SC-10 in outcome B.
- **With F-17 read the clique way** (section 8, item 19), the Raft rows' F-17 is open as worded. Then DRAFT and SPLIT lead with 2 MUSTs, with PD+fix and TiKV-TS on the loose reading (computed here, `clique.py`).

**Every gap ÷ bar in the settled cells, as worded.** Rule 2 asks this page to write each one down. Computed here over the 31 rows (`gaps.py`); "proof" comes from the cells.

| Requirement | Gap ÷ bar | Proof | Restated | Rows |
|---|---|---|---|---|
| SC-03 and SC-10 | 0.66 | ceiling | open | the 15 study rows DRAFT, MIN, RUST, SRV, LEAN, SPLIT, PD, SLOG, OBJ, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP, and all 11 closure rows |
| SC-03 and SC-10 | 0.66 | ceiling | fails | LANE, ISR, V4 |
| SC-03 and SC-10 | 0.77 / 0.98 | ceiling / structural | fails | CELL / BUY |
| PERF-04 | 0.07 (RR-15; RR-04 had recorded 0.39) | ceiling, reasoned from measured parts | fails (open if the loss is accepted) | MIN, RUST, SRV, LEAN, LANE, PD, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, the three MIN-P+par rows, SRV V=full Y=fwd, TiKV-persisted |
| PERF-04 | 0.43 / 0.93 | ceiling / structural | fails | OBJ / V4 |
| P-05 | 2.2 / 0.91 | ceiling | fails | OBJ / V4 |
| PERF-02, PERF-05, PERF-06, PERF-07 | 0.96, 0.96, 0.98, 0.84 | ceiling | fails | BUY |
| PERF-02, PERF-03, PERF-05, PERF-06, PERF-07, PERF-11 | 0.997, 0.996, 0.997, 0.999, 0.99, 0.91 | structural | fails | V4 |
| PERF-07, PERF-08 | 0.38, 1.17 | ceiling | fails (PERF-08 depends on its phase reading) | OBJ |
| DEP-12 | 0.93 / 0.995 | ceiling / structural | fails | BUY / V4 |
| F-05, F-19 | 1.08 each | ceiling | fails | BUY |
| DEP-21 | 12.58 | ceiling | fails | OBJ |

A failure proven by a counterexample carries no gap, and neither do most structural ones. F-17 (26 Raft rows) and F-15 (15 rows, and OBJ in both readings) fail as worded with no gap.

**PERF-04's gap is 0.07** (RR-15). The fail stands. Only its size changed.
- RR-04 first recorded 0.39. It added the round trip's p99 (58 µs) as a constant, to each follower's fsync and again for the client's hop. A p99 used as a constant is not a lower bound.
- RR-15 recomputed it from E-01's fsync table. With no network cost at all, the second-fastest of three fsyncs has p99 0.323 ms (`rr04.py` gives the same, and the evidence skeptic's sample gave 0.3215 ms). Counting the client's hop by a true bound, it is at least 0.326 ms. Both give a gap of 0.07.
- The figures in between estimate a real commit. They are not bounds. With the median round trip (30.6 µs) as a constant, the commit's p99 is 0.343 ms, or 0.373 ms with the hop (gap 0.23). With the round trip's p99 as a constant, it is 0.364 ms, or 0.422 ms with the hop (gap 0.40 by `rr04.py`, 0.39 as recorded).
- Every figure is above the 0.303 ms bar, so no `persisted` commit on this box can win JetStream's default test line.
- The PERF-04 rows' gap sums fell from 1.71 to 1.39. No place above 16 moved. PD (6 MUSTs, 1.39) now ranks 16th, above CELL (6, 1.54).

**The clauses rows fail as worded** (AMENDMENTS 1.3; cells in the `settled.json` files and the closure cards):

| Clause | Rows that fail it as worded | Why | What the evidence asks |
|---|---|---|---|
| SC-03 (Scale writes up) and SC-10: at least F_w = 64 effective writers per resource | all 31 | under Zipf 0.99 (a skewed load where a few keys get most writes) the hottest partition holds 5.5 to 9.8 % of the load, and nothing splits a partition. So every design reaches only 12 to 22 effective writers ([E-18], simulated) | "with every partition above half a writer's share split by the app": then 72 at 1,024 slots, 135 at 4,096 |
| F-17 (Partial partitions) | the 15 Raft study rows and the 11 closure rows | 5 of 280 five-node partial partitions with the leader up stayed stuck, by Raft's own vote rule ([E-38], simulated on etcd's Raft). That reads a "connected majority" as E-38 does: a star (one server with two-way links to a majority). None of the 5 has a clique (a majority whose every pair talks both ways). Like for like, with the leader up, 0 of 188 five-node and 0 of 111 three-node clique runs got stuck (RR-08; 299 and 159 if leader-crash runs are counted) | "a connected majority that includes an up-to-date replica", or a new election rule (+1 novel mechanism), or the clique reading (item 19) |
| F-15 (Outside services) | the 8 slot study rows whose restore mark lives in the object store (MIN, RUST, LEAN, SLOG, MIN-P, MIN-TS, SIDE, COMP) and the 7 closure rows built on them (COMP2 and its family) | a slot move records its new epoch in the store before use ([E-33]'s rule), so a move waits while the store is down. F-15 lets only wake, new replicas and old history wait (structural) | F-15's list adds slot moves, or the mark gets another home |
| P-05 (WebSocket fan-out by room) | OBJ and V4 only, on their own reasons | as worded the others are open (RR-02, RR-03). C + one hop is about 0.83 ms here, and E-08's relay measured 1.2 ms (Node) and 3.5 ms (Rust) at about half a core, one working point ([E-08]) | a coalescing window per room and about 1,000 sockets a core |
| F-05's handover clause | none now (RR-01) | etcd's handover paused its group 9.7 to 9.8 ms at the median and 24 to 31 ms at worst on this disk, mostly the disk's own stalls ([E-13]) | "C plus the box's normal longest gap between commits plus 5 ms" |

F-15 is not a clause no row meets. It is a clash between the store-held restore mark and F-15's list.
- DRAFT, SRV, RLOG and EMB-V8 move slots too. But they found a cluster by `fero init`, and A-08 leaves the home of their mark open, so their F-15 is open.
- The TiKV-shaped rows keep F-15 open, because writes, elections and new replicas use the local store, not the object store (family B's judges).
- The other lines of 1.3 leave the leading rows' cells open either way: SC-08 (b), SC-13's "small", SC-05 at 10 GB, F-10's untested clauses, and DEP-21's $10.

## 3. Outcome B: the clauses restated

### 3.1 The 20 study rows

Rows still in (no MUST failed): DRAFT, SPLIT, COMP. COMP beats both ([OUTCOME.md](judging/OUTCOME.md) B.2):

| Pair | Novel mechanisms | SHOULDs met | Interacting pairs | What decides | Winner |
|---|---|---|---|---|---|
| COMP against SPLIT | 3 against 4 | 5 against 5 | 283 against 295 | 1 apart, SHOULDs level, fewer pairs | COMP |
| COMP against DRAFT | 3 against 5 | 5 against 5 | 283 against 309 | 2 apart | COMP |
| SPLIT against DRAFT | 4 against 5 | 5 against 5 | 295 against 309 | 1 apart, SHOULDs level, fewer pairs | SPLIT |

The three meet the same five SHOULDs: DEV-04 (Published core), DEV-05 (Small code), OPS-11 (Debugging in production), P-22 (Delayed jobs, waiting takes, priorities) and SC-12 (Clients). Two mechanism re-rulings set SPLIT's numbers.
- RM-01: SPLIT now carries the merge its SC-04 relies on (278 to 295 pairs).
- RM-02: log replicas are not novel, because TiKV's witness has the same state, rules and role (SPLIT 5 to 4, DRAFT 6 to 5).

Ten study rows fail only PERF-04 (NATS JetStream): MIN, RUST, SRV, LEAN, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE. Their only durable rung is `persisted`.
- PERF-01 counts a win only when fero beats JetStream by more than the larger spread. JetStream's default acks one publisher at p99 0.550 ms, over runs of 0.536 to 0.783 ms ([E-09b]). So a win needs a p99 below about 0.30 ms.
- The best a `persisted` commit can do here is the second-fastest of three fsyncs plus a round trip. Sampled from E-01's one-writer fsync table, its p99 is at least 0.323 ms, before any CPU cost (section 2).
- Three agents computed this, and RR-04 ruled the failure stands. RR-15 set its gap at 0.07.
- Let back in alone, each of the ten wins among the 20, except SLOG (OUTCOME B.4).

### 3.2 All 31 judged rows: the matrix

`python3 tools/closure_matrix.py` rebuilds [matrix.md](judging/closure/results/matrix.md) byte for byte (checked for this page on a scratch copy):

| Reading | PERF-01: JetStream's default test line accepted as a loss | DATA-01 strict | Rule 3 as written | Rule 3, open MUSTs first |
|---|---|---|---|---|
| restated | no | no | **TiKV-TS** (0 novel, 4 SHOULDs, 244 pairs, 122 open) | COMP2 and COMP2 V=full (3, 6, 277, 99) |
| restated | no | yes | **COMP2** and COMP2 V=full (3, 6, 277, 99) | COMP2 and COMP2 V=full |
| restated | yes | no | **TiKV-persisted** (0, 5, 233, 121) | MIN-TS (4, 5, 253, 95) |
| restated | yes | yes | **MIN-P+par** and MIN-P+par V=full (3, 6, 264, 96) | MIN-TS (4, 5, 253, 95) |
| as worded | no | no | all out; rule 2: DRAFT, SPLIT, ISR, PD+fix, TiKV-TS | the same |
| as worded | no | yes | all out; rule 2: DRAFT, SPLIT, ISR | the same |
| as worded | yes | no | all out; rule 2: DRAFT, SRV, SPLIT, ISR, SLOG, RLOG, EMB-V8, SRV V=full Y=fwd, PD+fix, TiKV-TS, TiKV-persisted | the same |
| as worded | yes | yes | all out; rule 2: DRAFT, SPLIT, ISR, SLOG, RLOG, EMB-V8 | the same |

"Open MUSTs first" is not the rule as written. It ranks only the rows with the fewest open MUSTs, then applies rule 3. It shows what rule 3's blind spot decides.

**Why each line comes out as it does.**
- **Restated, strict, no loss: COMP2.**
  - The TiKV-shaped rows, SRV and PD fail DATA-01 by structure (RR-10, RR-17). Seven rows are left in.
  - Among them COMP2 has the fewest novel mechanisms (3, level with COMP, MIN-P+m and COMP+par C=cent V=full). With COMP+par C=cent V=full, it has the most SHOULDs (6).
  - That twin loses on pairs (282 against 277: its controller sessions). COMP2 V=full ties COMP2 on every count.
  - Checked pair by pair, every line of the matrix has a row no other row beats (computed here, `matrix_pw.py`).
- **Restated, loose, no loss: TiKV-TS.**
  - It has 0 novel mechanisms against COMP2's 3, so rule 3 stops at the first step. It has 23 more open MUSTs (122 against 99).
  - No judged row supported 15 of its cells, because none had its shape. The closure judges settled those, and 4 more on crossings ([cards.json](judging/closure/hybrids/cards.json)).
  - Its native twin (PD+fix with forwarding, `kw` threads and `par`, a Rust server) ties it on every count with no guessed cell (computed here, `twins.py`).
  - Its DATA-01 cell stays open on this reading (RR-18). In its TypeScript phase its servers keep the rows in a multi-version LSM written in TypeScript, neither data nor native code. The referee ruled that the loose reading accepts any engine proven equal to data, whatever its language. That proof is the row's only path to DATA-01. So RR-18 gave TiKV-TS a design rule: DATA-09's differential test binds its servers' store from the TypeScript phase on.
- **Loss accepted, loose: TiKV-persisted.** It comes back in, since its only failure was PERF-04. Against TiKV-TS: 0 novel against 0, and 5 SHOULDs against 4. Without the `memory` rung its P-15 (S) holds (family B's referee).
- **Loss accepted, strict: MIN-P+par.** The `memory` rung then buys no cell and costs three. P-10, P-15 and F-02 (M) are met without it and open with it (RR-11 to RR-13; computed here, `twins.py`). Dropping it also saves 13 pairs (264 against 277).
- **Open MUSTs first.**
  - Over the 31 judged rows, without the loss: COMP2 ties COMP2 V=full and MIN-P+m for the fewest open MUSTs among the rows in (99), on both readings. It beats MIN-P+m on SHOULDs. With the loss, MIN-TS comes back in with 95.
  - Over the searched mixes, without the loss, the same rule picks COMP2 in TypeScript for good (L `ts`: 3/6/277, 98 open, one guessed cell) with up to 6 guessed cells allowed, on both readings. It meets TEST-10 because it never has a second kernel (section 5.1). Past that the rule moves to rows that lean on guesses: COMP2 L=ts with a dedup window (D `win`, 4/6/275) from 7 guessed cells, and COMP2 L=ts with W `any` (3/6/269, 10 guessed cells) from 10 on.
  - Over the searched mixes, with the loss, it picks MIN-P+par in TypeScript for good (L `ts`: 3/6/264, 95 open, no guessed cell) with up to 9 guessed cells allowed, on both readings. That row ties MIN-TS on open MUSTs and beats it by rule 3: 1 apart on novel, then 6 SHOULDs against 5. From 10 guessed cells, MIN-P+par L=ts with W `any` (3/6/256) takes over (computed here, `analyse.py`; every cap from 0 to 148 rechecked by the fresh reader's `of2.py`).
- **As worded.** Every row fails at least SC-03 and SC-10, and the Raft rows also fail F-17. The rows level first are those whose only failures are those (plus ISR's SC-04). The strict reading adds DATA-01 to the TiKV-shaped rows. The loss takes PERF-04 off the `persisted`-only rows.

**COMP2 against its neighbours** (rule 3, pair by pair; computed here, `standings.py`):

| Pair | Novel | SHOULDs met | Pairs | What decides | Winner |
|---|---|---|---|---|---|
| COMP2 against COMP | 3 against 3 | 6 against 5 | 277 against 283 | F-22 (S), a cell family A's judges scored | COMP2 |
| COMP2 against COMP2 V=full | 3 against 3 | 6 against 6 | 277 against 277 | nothing: they tie on every cell and mechanism | level |
| COMP2 against MIN-P+m | 3 against 3 | 6 against 5 | 277 against 264 | F-22 (S) | COMP2 |
| COMP2 against COMP+par C=cent V=full | 3 against 3 | 6 against 6 | 277 against 282 | fewer pairs (the twin's controller sessions; section 7.5) | COMP2 |
| COMP2 against SPLIT | 3 against 4 | 6 against 5 | 277 against 295 | one more SHOULD | COMP2 |
| COMP2 against DRAFT | 3 against 5 | 6 against 5 | 277 against 309 | 2 apart | COMP2 |
| COMP2 against TiKV-TS | 3 against 0 | 6 against 4 | 277 against 244 | strict: TiKV-TS is out (DATA-01); loose: 3 apart | COMP2 (strict); TiKV-TS (loose) |

**What lifts COMP2 over COMP.**
- **Z `par`.** A damaged entry is repaired from a peer (PAR, Alagappan et al., FAST'18).
  - `par-repair` stays not novel (RM-03), so it adds no novel mechanism. It meets one more SHOULD.
  - With one bad entry on each of two replicas, every one of 276 judged states reaches a working leader ([E-37], model-checked). Family A's two judges scored F-22 (M and S) met for COMP2.
- **C `cent-co`.** The judges gave leader healing (COMP) and the controller loop (MIN-P) the same verdict on every cell they share. So leader healing earns no cell.
  - By the pair rule the controller form has fewer pairs. COMP with `par` (leaders heal) has 296, and COMP2 has 277 (`python3 tools/closure.py mechrow 'Z=par' COMP` and `mechrow 'C=cent-co,Z=par' COMP`).
  - Of those 19 pairs, 16 come from planner hints. COMP carries them as a mechanism, while COMP2 takes them as inputs to its controller (RM-04 kept it so). With hints counted on COMP2 too, the margin is 3 (computed here, `hints.py`).
- **A MUST, not counted by rule 3.** COMP2's DATA-09 is met under its design rule (RR-17), and COMP's is open (section 3.3).

### 3.3 Which DATA-01 reading the brief supports

This is the choice that decides between COMP2 and TiKV's shape. The files do not settle it. The referee left it to the user (RR-07, RR-10) and wrote the strict reading out (RR-17).

- **What the two requirements say.**
  - DATA-01: "Rows are folded by data's hot lane in log order, the same on writers, followers, clients and replays."
  - DATA-09: "If any layer moves to native code, the fold's results stay data's, proven by a differential test against data."
- **The loose reading** (the judges' and AMENDMENTS A-30's, in force). A server may fold in another engine if a differential test proves its rows equal data's fold. Read so, PD's shape is open on DATA-01. RR-07 found no step that shows its rows cannot equal data's. RR-18 added that the test, not the language, is what makes another engine acceptable. So a TypeScript store is judged like a native one.
- **The strict reading,** as RR-17 wrote it out. On writers and followers, data's own code folds every row of record: the rows a replica serves, reads, replays and judges writes by. That holds in every phase the row plans.
  - A row fails it by structure when its own tags put those rows in another engine. That is servers that fold in Rust or Go (F `all(srv)`: SRV and SRV V=full Y=fwd). It is also a kernel that writes the rows into its own LSM (K `kern` with an LSM: PD, PD+fix, TiKV-TS, TiKV-persisted). These are the two cases RR-10 named, and the tool encodes exactly them. TiKV-persisted now carries PD's reason, since PD's rule is tried first.
  - Rows whose tags leave the fold to a later design choice are left open, not failed. There are four such cases:
    - a `ts→rs` row's native step,
    - an H `srv` row after its Rust core,
    - a kernel worker's compact copy of the rows (M `kw`),
    - and K `lib` with an LSM that stores data's rows.
  - Such a row passes for sure only by stating that data keeps folding.
  - Read word for word, DESIGN-V5's plan (a Rust L0 to L3, a kernel that owns the rows) would fail most rows (the evidence skeptic, F1). The referee did not read it so: no second agent confirmed such a fail. That word-for-word reading stays a user choice (section 8 item 15).
- **A middle reading.** Data's lane, or a port of data's lane proven by DATA-09's test, folds the rows, and no other engine does.
  - REQUIREMENTS X3 offers exactly these two ways out of the clash between data (JavaScript) and a native kernel. In its words: "data folds on the JS side; or port data's apply lane with differential tests".
  - Read so, SRV and its twin pass DATA-01, and PD's family still fails it.
  - Every matrix line keeps its winner. SRV is out on PERF-04 without the loss. With the loss, SRV loses to MIN-P+par: 4 novel and 5 SHOULDs against 3 and 6 (computed here, `middle.py`).
- **Why the brief leans strict, or middle.**
  - BRIEF item 6 says "`data` stays the state engine", and its change records are fero's wire format.
  - In TiKV's shape the servers' engine is a multi-version store in an LSM under two-phase commit. Data folds only on clients. Both PD judges wrote "data is not the engine on PD's servers" (RR-07). SPACE's own PD line says the same ("`data` is not the engine on servers", SPACE's goal G6).
  - SPACE also marks a Rust or Go server as a risk to SPACE's goal G6. SRV's row says servers "cannot run methods, rules or `data` views without embedding JS". Its note on L `rs-srv` says "`data` folds on clients only". That backs the referee's strict framing. X3 backs the middle one.
  - A test can prove two engines give equal rows. It does not make a different engine data.
- **What the strict reading asks of COMP2: a design rule** (RR-17, recorded under `pins` in [A.settled.json](judging/closure/hybrids/A.settled.json) on rows A1 to A7). Read word for word, COMP2's plan moves "records → rows" to Rust at its native step, and in TypeScript lets the kernel worker own the rows. The rule keeps data the engine on every full replica, in every phase:
  - The native core, when it comes, holds only L0 and L1 (the journal, Raft and the log) and never folds rows.
  - Records cross to JavaScript in batches (A-30's call rules; E-03: under 1 ns a record at batch 256). L2 and data's own lane fold every row there, as RUST's row has it (X3's first way).
  - Every full replica keeps a full data copy of the rows (E-05's `projection all`).
  - The kernel worker keeps at most an index or a cache of the rows (A-27). It is never served, and it is checked against data's rows by F-21's hash (E-05: the two digests matched).
  - The rule adds no mechanism and moves no rule-3 count. It meets DATA-09 by construction, the reason both judges gave RUST's met cell. The attribution records this as an override, since no axis tag says it. Without the rule COMP2 would have 100 open MUSTs, not 99.
  - SRV V=full Y=fwd (A8) does not carry the rule, since its own tags fold natively. COMP, MIN-P and the other study rows could carry it too. It would matter only for "open MUSTs first".
  - If a later timing shows L2 must go native, the row drops the rule. DATA-09 then goes back to open, and on the strict reading the row fails as SRV does.
  - On the middle reading the rule is not needed: a port proven by DATA-09 is allowed.
- **What the design rule costs: memory.** E-05 put both copies at 510 to 528 B a small row, under DEP-13's 2 KB. But [E-34] found that with every row also on the main thread, the worker form wakes no faster than the main-thread form (23 s small, 32 s for 5 GB). It holds the rows twice: 12 GB RSS for the 5 GB case. So 10 GB of 2 KB rows in that form (about 21 to 24 GB, reasoned) cannot run on the 16 GB box. An index without the values halves the cost. SC-05 (10 GB writable within a minute of a wake) and DEP-13 (small copies) stay open either way, and their closers now time the two-copy form (section 5.4).
- **What the loose reading has for it.** DATA-09's words do say "any layer". The judges read it that way. The user may prefer a shape with no novel mechanism, even at the cost of the brief's sixth aim. On aim 4's own two counts, TiKV-TS beats COMP2: 0 novel against 3, and 244 pairs against 277.
- **Grounds rule 3 never counts, on the loose reading.** Even where the rule names TiKV-TS, these favour COMP2. None is a judged order. Each is a fact from the files.
  1. Evidence: COMP2 has 33 MUSTs met against TiKV-TS's 10, because no experiment ran TiKV's shape.
  2. Build size: E-44 estimates about 8,000 fero-owned lines for a Raft-per-group row. It gives no figure for two-phase commit, a timestamp oracle and a multi-version store. Its one figure covers 11 rows, so it cannot separate COMP2 from its neighbours.
  3. API: TiKV-TS's U `cli` runs no user code on servers. So fero's methods would become declarative rules or WASM (SPACE 2, U).
  4. Cost at 10 writes a second on Fly: COMP2's shape costs $7.52 to $7.89. PD's costs $18.64 to $19.01, or $9.58 to $10.11 with the placement process inside the stores (section 6).
  5. The data seam: DATA-03 needs a data record to ride inside a two-phase-commit prewrite, a format nobody designed.
  - One caveat on TiKV's 0. Family B left open how its timestamp oracle restarts after an unclean loss of the controller's majority (OPS-07). A store-held window there is the restore mark's kind of rule, which is novel. TiKV's shape would then have 1 novel, still 2 below COMP2, so no order moves (reasoned).

## 4. Could an unjudged mix beat it? The closure pass

### 4.1 Why it was needed

The 20 study rows are 20 points in a space of 22 axes. Draft 2 priced six rows between those points by hand. Two of them (SPLIT2 and PD+fix) ranked above COMP2 on copied cells. A hand search never ends: the next reader can always try one more mix. So the closure pass let code build every mix near the judged rows and rank them by the same rule. Then it sent the best to blind judges ([judging/closure/README.md](judging/closure/README.md)).

### 4.2 Step 1: the attribution reproduces every judged row

For each requirement part, [attrib/](judging/closure/attrib) names the axes that decide its cell. It gives the verdict for each option, read from the judges' own reasons. [mechanisms.json](judging/closure/mechanisms.json) gives each mechanism the options that carry it. [constraints.json](judging/closure/constraints.json) gives the options that force or forbid others. Where a cell follows something no axis expresses, it is an **override**: that row keeps its own cell, and no other row may borrow it.

`python3 tools/closure.py check-all`, run for this page:
- All 4,588 cells of the 31 rows reproduce, with 0 mismatches.
- There are 36 overrides. 29 are V4's. The other 7 are DATA-09 on the seven family A rows that carry COMP2's design rule (RR-17; section 3.3).
- 112 mechanism entries reproduce with 0 mismatches. None of the 54 constraints is broken by a judged row.

Only 3,032 of those cells are a real test: the 2,960 cells of the 20 study rows, and the 72 the closure judges scored. The other 1,556 cells of the closure rows are the attribution's own predictions, written into the cards, so they reproduce by construction.

Before the families judged (the attribution at commit 12defff), it predicted 63 of the 72: all 25 of family A's, and 38 of family B's 47. The other nine were then written into the attribution: SC-06 S on three rows, and the six crossing cells of section 4.5 (computed here, `a5.py`). So the code reproduces every judged cell. Before the blind judging, it had predicted the frontier rows' judged cells 63 times in 72.

### 4.3 Step 2: the search

`closure.py search` works in three steps.
1. It builds every mix within two axis changes of each judged row (BUY left out), and of seven hand-priced rows (draft 2's six and one more).
2. It drops the mixes a constraint forbids. It predicts each one's cells, mechanisms and pairs, and ranks the rows that are in by rule 3.
3. It walks four more rounds out from the 25 best.

Since commit bcb9afc the search seeds from all 31 judged rows, not only the 20 study rows. So the 11 closure rows' neighbourhoods are now walked too. Draft 3 had added that "shell" of about 21,500 mixes by hand. Rerun today, the shell adds no row.

| Reading | Rows searched | Rows in | Draft 3's ladders |
|---|---|---|---|
| restated, loose, no loss | 372,354 | 7,973 | 363,776 searched, 15,432 in |
| restated, strict, no loss | 381,087 | 17,774 | 379,172 searched, 16,231 in |
| restated, loose, loss accepted | 342,555 | 11,992 | |
| restated, strict, loss accepted | 372,925 | 13,331 | |

Sources: [ladder-restated.md](judging/closure/results/ladder-restated.md), [ladder-restated-DATA-01_reading.md](judging/closure/results/ladder-restated-DATA-01_reading.md), [ladder-restated-PERF-01_losses.md](judging/closure/results/ladder-restated-PERF-01_losses.md) and [ladder-restated-PERF-01_losses-DATA-01_reading.md](judging/closure/results/ladder-restated-PERF-01_losses-DATA-01_reading.md). This page reran the four searches and got the same counts (computed here, `dump.py`).

**Which TiKV rows the search reaches.**
- TiKV-TS and TiKV-persisted are seeds now, so every reading starts from them.
- Before the fix, TiKV-TS was out of reach: it is 6 axis changes from PD+fix. TiKV-persisted is 8 changes from PD, and the old search reached it only on the loose reading with the loss accepted.
- TiKV-TS's native twin (PD+fix with forwarding, `kw` threads and `par`, a Rust server) is 3 changes from both TiKV-TS and PD+fix. So the search still does not reach it. Priced by hand, it ties TiKV-TS: 0/4/244, 122 open, no guessed cell (computed here, `twins.py`).

### 4.4 Step 3: rows far from any judged row win only on guesses

A predicted cell is only as good as the judged rows behind it. The **ladder** ranks the rows that are in as more guessed cells are allowed.

**The ladder files now apply rule 3 pair by pair.** Rule 3 is not transitive: two rows tie on the novel count when they are fewer than 2 apart. So a row 2 above the fewest can beat a row 1 above it, while it loses to the row with the fewest. Then rule 3 can go round in a circle, and no row beats all the others. Draft 3's ladder files used a shortcut that still printed a row there, and that row was beaten. They also tested only some caps (0 to 3, 5, 8, 12 and so on). Commit bcb9afc fixed `closure.unbeaten()` to apply rule 3 pair by pair. The ladder files now test every cap from 0 to the largest count any row has, and print a run of caps with the same result as one line ("4 to 47"). Where rule 3 circles, the files say "none: rule 3 goes round in a circle". The fresh reader's own pass at every cap (`allcaps.py`) gives the same rows as the rebuilt files.

**Strict reading** ([ladder-restated-DATA-01_reading.md](judging/closure/results/ladder-restated-DATA-01_reading.md)):

| At most this many guessed cells | Rows in | Unbeaten | Novel / SHOULDs / pairs / open | Its guessed cells |
|---|---|---|---|---|
| 0 | 96 | COMP2, with twins that tie it on rule 3's counts (V=full, H=both, H=srv, U=cli H=srv, V=full H=both, and 2 more) | 3 / 6 / 277 / 99 | none |
| 1 to 3 | 272 to 528 | the same, plus twins with one guessed cell (L=ts; L=rs+napi I=raft-rs), and at 3 twins with P=slot+rule (3 guessed cells) | 3 / 6 / 277 / 99 | none |
| 4 to 47 | 620 to 17,774 | none: rule 3 goes round in a circle | | |

No searched row has more than 47 guessed cells, so the circle covers every cap above 3.

At 4 the circle is:
- COMP2 beats SPLIT2 with a separate controller, every replica a voter, lease reads, separate servers that run no user code, and one process per project (2/5/267, guessing P-05, SC-05 and TEST-12). They are 1 apart, and COMP2 has one more SHOULD.
- The SPLIT2 row beats COMP2 with a dedup window and the draft's journal (D `win`, S `jrnl +tier`: 4/6/275, guessing P-07, SC-05, SC-06 S and SC-15). They are 2 apart.
- The window row beats COMP2 itself: 1 apart, SHOULDs level, 2 fewer pairs.
- A second circle runs through an H2 row with K `lib` and an LSM (1/3/249, guessing P-05, DATA-01, SC-06 S and TEST-12). It beats COMP2 (2 apart), and the SPLIT2 row beats it (1 apart, 5 SHOULDs against 3).

Draft 3's circle started at 5. The fixed search found these rows, so it now starts at 4.

**Loose reading** ([ladder-restated.md](judging/closure/results/ladder-restated.md)):

| At most this many guessed cells | Rows in | Unbeaten | Novel / SHOULDs / pairs / open | Its guessed cells |
|---|---|---|---|---|
| 0 | 143 | TiKV-TS | 0 / 4 / 244 / 122 | none |
| 1 to 9 | 485 to 2,283 | none: rule 3 goes round in a circle | | |
| 10 | 2,571 | PD+fix V=full D=pid X=saga L=ts→rs I=port Y=fwd M=kw Z=par | 1 / 5 / 248 / 121 | 10: P-05, P-07, P-09, P-10, P-13, P-14, P-17, P-22 S, DATA-03, F-02 |
| 11 | 2,782 | the same, plus six more 1/5/248 rows (PD+fix twins with process ids and sagas, and a COMP+par row with TiKV's kernel) | 1 / 5 / 248 / 121 | the same |
| 12 to 38 | 3,072 to 7,973 | none: rule 3 goes round in a circle | | |

At 10 and 11 guessed cells one shape is unbeaten: TiKV's shape with process ids for dedup (D `pid`) and sagas. It rests on 10 guessed cells, so it is a guess, not a winner. No searched row has more than 38.

At 1 the circle is:
- TiKV-TS's twin with client sessions and sagas in place of two-phase commit (1/5/253) beats TiKV-TS: 1 apart, one more SHOULD.
- The same shape with a dedup window (D `win`) in place of sessions (2/5/252) beats the sessions row: 1 apart, SHOULDs level, one pair fewer.
- TiKV-TS beats the window row: 2 apart.
- Both rows guess only DATA-03, which is open for them under any rule. The ladder file lists the 1/5/253 row first at 1.

**The two loss ladders never go round in a circle.**
- **Strict, loss accepted** ([ladder-restated-PERF-01_losses-DATA-01_reading.md](judging/closure/results/ladder-restated-PERF-01_losses-DATA-01_reading.md)). MIN-P+par and its twins (3/6/264/96) lead at 0 to 5 guessed cells. From 6, PD with K `lib`, every replica a voter, an LSM and TypeScript first leads (0/4/233/119, 6 guessed cells: P-05, DATA-01, DATA-03, SC-06 S, TEST-01, TEST-12). At 7, MIN with split and merge and two-phase commit joins it. From 17 the lead passes to rows with W `any` and more guesses (0/4/228 at 17, 0/4/225 at 18, 0/4/220 from 19), and H2 rows join from 22.
- **Loose, loss accepted** ([ladder-restated-PERF-01_losses.md](judging/closure/results/ladder-restated-PERF-01_losses.md)). TiKV-persisted and its TypeScript-first twin lead at 0 to 10 guessed cells, with PD-shaped twins (0/5/233/121). At 11 and 12, rows that need 11 or more guessed cells lead (0/5/228). From 13 on, rows with W `any` lead (0/5/220).

**The other seven ladders.** The F_w, N_res, shared tier, region scope and fsync figure ladders all match the loose ladder: TiKV-TS at 0, a circle at 1 to 9 and 12 to 38, and the 10-guess PD+fix row at 10 and 11. The worded and "other" ladders have no row in.

**The K `lib` rows with an LSM.** Six of the rows that beat COMP2 at 4, and the strict loss ladder's leader from 6, have K `lib` with an LSM store. DATA-01 is a guessed cell on each. RR-17 leaves such rows open, not failed: a reading call the user owns.
- Read word for word (any LSM store, any server fold in Rust or Go, or any H `srv` row with a native server fails DATA-01), those rows drop out.
- The strict circle still starts at 4, through the D `win` row and the SPLIT2 row with an embedded host (2/5/267). It holds from 4 to 11.
- From 12, rows that lean on guesses are unbeaten again: SPLIT2 with a separate controller, every replica a voter and one process per project (2/6/262) at 12 to 14, and the same with a dedup window and W `any` (3/6/253) from 15 up.
- With the loss, MIN-P+par leads at 0 to 7. Rule 3 circles at 8 and 9. MIN-P+par with W `any` (3/6/256) is unbeaten at 10, and a circle runs from 11.
- Computed by filtering the same searched rows at every cap (`wcycle.py` here, `wfw.py` in the final recheck). The fresh reader (R5) had found the circle moving from 5 to 6 on the old search. On today's search it starts at 4 either way.

**Why the far rows rise.** A guessed cell falls to its part's fallback verdict, which is usually "open". Rule 3 never counts open MUSTs. So a row that drifts away from every judged row pays nothing for the cells nobody looked at. On the strict reading every row that beats COMP2 carries 4 or more guessed cells, and from 4 up rule 3 names no winner at all. That is movement on guesses, not on evidence.

**Who beats the two winners, and on how many guesses** (computed here, `analyse.py`, with rule 3 pair by pair on the same search):
- **Strict reading, COMP2.** No row with 3 or fewer guessed cells beats it.
  - 8 rows need 4. Two are COMP2 and its V=full twin with D `win` and the draft's journal (4/6/275). They win by 2 pairs while adding the dedup window, a novel mechanism. The other six have K `lib` and an LSM store: one H2 row and five SPLIT2 rows, each guessing P-05, DATA-01, SC-06 S and TEST-12.
  - 29 rows need 5, 64 need 6, and the other 7,285 of the 7,386 beaters need more.
- **Loose reading, TiKV-TS.** Ten rows with one guessed cell (DATA-03) beat it. Nine are TiKV-TS's own twins with client sessions and sagas. One is SPLIT2 with TiKV's kernel and LSM (1/5/261). These are beaten in turn, and rule 3 goes round in a circle. So on the loose reading the family is settled, but no member is. A judging pass on one row cannot settle it (section 9).
- **Loose reading, COMP2.** Twenty-five rows with no guessed cell beat it, all of PD's family with 0 novel mechanisms.

### 4.5 Step 4: the frontier rows, judged blind

The search's best rows under the main readings, and draft 2's hand-priced rows, went to two families of blind judges.
- **Family A** is COMP2 and its neighbours, 8 rows: MIN-P+m, COMP2, COMP2 V=full, COMP+par C=cent V=full, MIN-P+par, MIN-P+par V=full, MIN-P+par C=cent V=full, and SRV V=full Y=fwd.
- **Family B** is TiKV's shape, 3 rows: TiKV-TS, TiKV-persisted and PD+fix.

Two judges per family scored each cell no judged row supported, every crossing they saw, and each row's mechanism list. A referee settled each family ([A.settled.json](judging/closure/hybrids/A.settled.json), [B.settled.json](judging/closure/hybrids/B.settled.json)). That was 72 cells: 25 in family A (all unsupported), and 47 in family B (41 unsupported, 6 opened on crossings).

**Did the judges agree with the predictions?** Mostly.
- **Family A.** Both judges scored the same 25 cells and agreed on all 25. Judge 1 also scored one more cell (A8 SC-05). Every cell came out as predicted: F-22 (M and S) met on the `par` rows, SC-05 and F-12 open, and SC-03 and SC-10 failing as worded like every row. No crossing was upheld.
  - The mechanism lists moved a little. Three record fixes added 3 pairs to every `par` row (274 to 277 for COMP2; RF-01 to RF-03).
  - Learners stay in the V `full` rows as the healer's catch-up stage, so COMP2 V=full equals COMP2.
  - Both judges also added link pings to the separate-controller rows. Section 7.5 shows that this one ruling keeps COMP2 ahead of COMP+par C=cent V=full.
- **Family B.** The two judges agreed on all 41 unsupported cells. All predicted cells but one held: SC-06 (S) came out met, not open (the critic had flagged that rule).
  - Crossings opened six cells the prediction had copied from judged rows. TEST-07 and DEP-20 opened on TiKV-TS (both judges raised them). P-15 (M and S) opened on TiKV-TS and PD+fix, the rows with the `memory` rung. Only judge 2 raised that one. Judge 1 kept "met", and the referee upheld judge 2.
  - Learners stay in TiKV-TS and TiKV-persisted: +7 pairs when ruled, and +8 since RM-08 added link pings, which learners pair with.
- **After the families,** before draft 3. A referee carried family B's P-15 trace over to the saga rows with the `memory` rung (RR-11). The referee also found that TiKV's own source keeps pinged links between stores, so PD's family carries link pings (RM-08: +9 pairs). On every line of the matrix, the winner stayed the same.
- **After draft 3** (RR-12 to RR-19; section 11.3). P-10 and F-02 opened on the `memory`-rung rows. PERF-04's gap became 0.07. The strict DATA-01 reading was written out, and COMP2's design rule was recorded. TiKV-TS's loose DATA-01 stayed open, and TEST-07 stayed met on the M `kw` rows. Again no winner moved on any matrix line or ladder.

### 4.6 Draft 2's two unjudged rivals, now

- **PD+fix** was judged (family B): 0 novel, 3 SHOULDs, 247 pairs, 122 open MUSTs, and no MUST failed restated. V-02's F-15 and OPS-14 point is settled: both are open. On the strict reading it fails DATA-01. On the loose reading it loses to TiKV-TS, which meets one more SHOULD (F-22 S, through `par`).
- **SPLIT2** (SPLIT made like COMP2) was not judged. Built as draft 2 described it (N `tier` kept), it has 3 novel, 6 SHOULDs, 273 pairs and 102 open MUSTs. With N `proc` it has 269 pairs (computed here, `seeds.py`; V-01). It ranks above COMP2 by 4 to 8 pairs, but only on 15 guessed cells (14 with N `proc`), mostly pattern MUSTs. That is the kind of lead section 4.4 discounts.

### 4.7 The options no judged row holds

The search uses only options some judged row holds. A critic asked whether an option no row holds could rank above the frontier ([critic-unheld-options.md](judging/closure/results/critic-unheld-options.md)). Its prices predate the families' rulings: it gives COMP2 274 pairs and TiKV-TS 225. The prices below come from rerunning its own script, `critic/price.py`, on today's files: COMP2 277, TiKV-TS 244. It found:
- **Nothing unheld can reach 0 or 1 novel mechanism on a slot row.** Each of the three novel mechanisms (slot move, restore mark, dir lease) comes off only through options rows already hold: P `split`, T `tso` with D `txn`, or S `lsm`. No unheld option removes one without failing a MUST.
- **No unheld option can be named before a judging pass.** Each leaves the cells its axis decides unjudged. Counted as the tool's guessed cells on COMP2 with that one option: 7 for D `keys`, 12 for X `ramp` (or `rampv`), 72 for R `vsr`, none for Y `proxy` (computed here with `closure.cell_report`). The critic's 11, 15 and 72 came from an older attribution and cannot be reproduced.
- **Four leads could reorder the top.** Three could beat COMP2. The fourth, Y `proxy`, bears only on TiKV's shape: on rows with U `any` it costs 6 more pairs (COMP2 with Y `proxy` prices 3/283).

| Rank | Option | What it could do | The experiment |
|---|---|---|---|
| 1 | D `keys`: one key table for fero's own retries, client sessions gone | 8 to 10 fewer pairs on COMP2's tier (267 to 269); or 3 fewer with one more novel mechanism (4 / 6 / 274), if the key table is novel | run E-32's dedup-and-fence crossing with E-20's `keys-fwd` rules in place of `sess`, and pin the key table's bytes at DEP-21's three loads against DEP-13 |
| 2 | X `ramp` in E-24's `rampv` form: sagas kept, atomic reads added | +1 SHOULD (P-15 S), +1 novel, +15 pairs (4 / 7 / 292): it would beat every 3-novel row on SHOULDs if only one new mechanism is novel | extend E-24's RAMP model to versions that carry earlier saga units' effects, with `rampv`'s vector; check read atomicity and a bound on rounds; ablate by DEV-10 |
| 3 | Y `proxy`: stateless proxies at the public address | 3 fewer pairs on TiKV's shape only (241) | price DEP-21 for TiKV's shape with the proxy inside its store machines |
| 4 | R `vsr`: Viewstamped Replication with protocol-aware recovery | up to 10 fewer pairs on COMP2's tier (267, if PAR sits inside VSR's log mechanism; 259 with D `keys` too), or one SHOULD lost (DEV-04) | cost it as Q-37 asks: two counters list its units with reads and writes; the referee rules DEV-04 (S) for a port of TigerBeetle's core |

On today's prices each of D `keys`, `rampv` and `vsr`, at its best, beats COMP2 by rule 3, with no MUST predicted to fail.
- D `keys` wins on pairs. If its key table is novel, it is 1 apart with SHOULDs level and fewer pairs.
- `rampv` wins on one more SHOULD, at 1 apart.
- `vsr` wins on pairs.

So "settled" on this page means settled among the options some judged row holds. A lead whose experiment passes still needs a judging pass of the cells its axis decides. It also needs two counters ruling its novelty (DEV-10 (e)) before it can be named.

### 4.8 So, could an unjudged mix beat COMP2?

On the strict reading, not on evidence among the options judged rows hold.
- Every cell of COMP2 is judged or supported by a judged row: 0 guessed cells (`seeds.py`).
- Its two cells no judged row supported, F-22 (M and S), were scored met by family A's two judges (V-12).
- Three of its MUSTs are open for the `memory` rung's lost tail: P-15 (RR-11), and P-10 and F-02 (RR-12, RR-13). The evidence skeptic had flagged these two. Their support never ran the rung, yet AMENDMENTS K-09 names lock fence tokens and session floors in the tail an unclean stop can lose. The referee opened them, and no line moved.
- TEST-07 stays met (RR-19). The kernel worker's compact rows are built from the same records, so a rerun rewinds them with the same inverse records. E-06's undo sits about 200 times under the 10 ms bar. One test is owed: time a rerun in fero test with the kernel's own state rewound too.
- DATA-09 is met by construction under its design rule (RR-17).
- The evidence skeptic read 25 of COMP2's predicted cells against the reasons of the judged rows behind them. 22 carried the same reason unchanged. The other three were P-10, F-02 and TEST-07, now ruled as above.

A row needs at least 4 guessed cells to beat COMP2, and the critic's three leads need an experiment and a judging pass first. What can still move the answer:
- a user choice (section 8)
- a model that breaks a mechanism COMP2 rests on, or a measurement (section 9)
- a critic's lead that passes its experiment and its judging.

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
| X | saga units (writes across partitions) | `saga` | sagas: fenced locks, an intent row and steps; a reader may see half a saga unit |
| S | storage | `jrnl +tier(store)` | one journal per process, plus an object-store tier; the restore mark lives in the store's manifest (A-08) |
| F | where rows are folded | `all` | every full replica folds the rows with `data` |
| W | reads and subscriptions | `any ridx` | from any ready replica at a position, or by read index |
| U | where user code runs | `any` | methods run on the server the caller reached; writes are forwarded to the leader |
| H | where fero runs | `emb` | inside the app's own Node process |
| L | language | `ts→rs` | TypeScript first; a Rust core later, checked byte for byte under the same seeds. Under its DATA-01 design rule (RR-17) the Rust core holds only L0 and L1: it orders, stores and ships records but never folds rows, and `data` keeps folding in JavaScript (X3's first way; section 3.3) |
| I | the Raft core | `port` | etcd's Raft ported to TypeScript ([E-10]); raft-rs later |
| Y | how a write reaches its leader | `fwd` | any server takes it and forwards it |
| M | threads | `kw` | the kernel on a worker thread; user code and the rows on the main thread. Under the design rule every full replica keeps a full `data` copy of the rows, and the worker keeps at most an index or cache checked against it (section 3.3) |
| Z | storage faults | `par` | a checksum per entry; a replica with a bad entry keeps its id, neither votes nor stands, and copies the entry from a peer whose commit covers it (more under the table) |
| N | tenancy | `proc` | one process (one Fly app) per project |

**Z `par` in more detail.**
- It has 7 rules, each shown needed by E-37's mutants: 8 of 9 caught (89 %), or 8 of 10 (80 %) counted on the model as written.
- The record adds two rules. The append guard is in the model and not needed for safety; it is kept because F-22's words ask for it. The read rule (a damaged replica answers END at that position) is not modelled.
- The disk incarnation stays, for the `memory` rung's unclean stop.

**In one line:** MIN-P (the study's minimal design with groups owned by the project), with a `memory` rung beside `persisted` and `none`, and with `par`.

**Twins that tie it.**
- COMP2 V=full (every replica votes; learners only while a heal catches a new copy up) ties COMP2 on every cell, mechanism and pair ([A.settled.json](judging/closure/hybrids/A.settled.json)).
- The strict ladder also lists twins on H and U that tie it on rule 3's counts. Rule 3 cannot separate them.
- This page keeps AMENDMENTS 4's picks (`+lrn`, `emb`, `any`). SC-14 has other regions follow through learners, and `emb` is fero's form today.
- The H `srv` twins are left open on the strict reading after their Rust core, not failed: their servers can keep a Node host for `data` (RR-17). They pass it for sure only by stating that `data` keeps folding, as COMP2's design rule does.

**COMP2 in TypeScript for good** (L `ts`) also ties it on rule 3's counts (3, 6, 277), with one guessed cell (PERF-08, open either way).
- It has 1 fewer open MUST (98): TEST-10 is met, because there is never a second kernel. DATA-09 is met for both (COMP2's by its design rule).
- So "open MUSTs first" over the searched mixes picks it, with up to 6 guessed cells allowed (section 3.2).
- This page keeps `ts→rs`, because the native step is held for the rows TypeScript may not win. Those are PERF-04's default test line, PERF-08's native column, and PERF-07's single client (section 9, step 8).
- Keeping it costs TEST-10 and a second kernel, and raft-rs 0.7.0 cannot run etcd's files (G-24). If step 6's timing shows TypeScript wins those rows, L `ts` is the better row.

### 5.2 Its score

From the closure card ([cards.json](judging/closure/hybrids/cards.json)) and `closure.py`'s tally (computed here, `comp2cells.py`, `standings.py`):
- **As worded:** 4 MUSTs failed (F-15, F-17, SC-03, SC-10; gap sum 1.32), 96 open, 32 met.
- **Restated:** no MUST failed, 99 open, 33 met.
- **SHOULDs:** 6 met: P-22, SC-12, F-22, DEV-04, DEV-05, OPS-11.
  - 3 not met: P-15 S (readers can see half a saga), DEV-02 S (at most 10 pairs), and DEP-15 S (two copies survive a crash, which needs a witness COMP2 does not have).
  - 7 open: P-20, PERF-09, SC-06, DEP-10, DEP-14, DEP-19, TEST-11.
- **Novel mechanisms:** 3 of its 50 mechanisms: the slot move, the restore mark in the store's manifest, and the dir lease (one process per dir, with an epoch fence).
- **Interacting pairs:** 277.

**Its PERF-04 is open, not met** (RR-16).
- No measurement shows any rung winning JetStream's default single-publisher test line. E-02's `memory` rung read p99 0.57 ms in TS and 0.33 ms in Rust, at 50,000 writes a second, with no client hop and no gateway ([E-02]). Neither beats 0.55 ms by JetStream's spread, so neither is under the bar of about 0.303 ms.
- Nor is a loss shown. E-02 never ran one write in flight, and one working point is no ceiling (as RR-02 and RR-03 ruled for P-05).
- A `memory` commit needs no fsync: about one round trip to a follower plus the client's hop, 2 × 30.6 µs at the median in Rust (E-01). That is far under the bar, so a win is not ruled out (reasoned).
- Draft 3 noted that the card's reason still called Rust's 0.33 ms "a win", written before RR-04's bar. RR-16 restated it as above. The cell did not move.
- This is MIN-P+par's best argument. The rung adds 13 pairs and opens P-10, P-15 and F-02 (M). And it exists only to win a row no measurement shows it winning. That is why section 9 builds without it first.

### 5.3 What it gives up

All of this is reasoned or measured. None of it is counted by rule 3.
- **Against leader healing (COMP).** The controller needs 4 more healing rules (18 against 14, [E-16]). As first written it had a stuck state, which A-20 removes.
  - While `#meta` has no leader, healing waits as well as moves. 24 to 62 % of the judged states could not finish healing then: a delay, not a stuck state.
  - 9 of the controller's 21 mutants are undecided (G-09).
  - It drops COMP's K-27 (no one decides a give-up), and turns K-07 into the controller healing and moving at once.
- **`par`.** It has 7 rules against `rejoin`'s 2, plus the append guard and the END read rule of the record (section 5.1). It was checked with three voters and no voter change (G-15), and not on one journal per process (K-24). Since RF-03 it pairs with the group's config, so the voter-change crossing now shows in the count.
- **The `memory` rung.**
  - Its safety inside Raft was never modelled (K-09, G-05). If a group's majority stops uncleanly within the second before the disks catch up, the tail it acknowledged is gone.
  - A saga with one step on a `memory` resource can then be left half done, so P-15 (M) is open (RR-11).
  - The same lost tail can send the writer's fence table back, so P-10 (M) is open (RR-12). A late write under an older lock token could then commit.
  - It can also lose a refusal or a session floor, so F-02 (M) is open (RR-13). An attempt once told "refused" could then commit.
  - All three are open, not failed: the trace is reasoned, not run.
  - RR-11 named two closers: commit a saga unit's steps on a `memory` resource at `persisted`, or refuse the unit. The first needs a rung chosen per write, which COMP2's Q forbids (footnote 13). So for COMP2 the closer is refusal (RR-14).
  - With RR-12's and RR-13's closers this is one rule: **locks, fences, sagas and session-bound writes never sit on a `memory` resource.** RR-12 and RR-13 also allow a recovery rule instead: `fero recover --unclean` restarts the fence tables and starts a new session generation.
  - And the rung exists only to win a row no measurement shows it winning.
- **The DATA-01 design rule.** Its price is memory (section 3.3). E-34 found that the two-copy form holds the rows twice and wakes no faster than the main-thread form. It cannot hold 10 GB of 2 KB rows on a 16 GB box. An index without the values halves that. SC-05 and DEP-13 carry this risk (section 5.4).
- **Cost.** One process per project, with its own volume. Awake all month it costs $2.34 against the $2.19 free bar ([E-41]). At 10 writes a second it passes $10 at the top of its range in São Paulo, Johannesburg, Tokyo and Singapore or Sydney (section 6).
- **Outside services.** As worded, a slot move waits while the object store is down (F-15).

### 5.4 Every MUST it leaves open (restated: 99)

REQUIREMENTS rule 1 asks this page to list each open MUST with what closes it.
- The lines come from the "What closes it" column of [judging/rows/COMP.md](judging/rows/COMP.md), whose cells COMP2 shares except F-22 (met here) and DATA-09 (met by its design rule).
- Lines that name COMP's leader healing take MIN-P's closer ([judging/rows/MIN-P.md](judging/rows/MIN-P.md)). P-10 and F-02 take the closers of RR-12 and RR-13.
- The set was checked against `closure.py`'s tally (`comp2cells.py`): draft 3's 98, plus P-10 and F-02, minus DATA-09.
- `python3 tools/closure.py card '' COMP2` prints the cells as predicted from COMP2's options. It shows DATA-09 open (100), because the design rule is recorded on the judged row, not on any option.

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

*A model to write first (11).*

| Requirement | What closes it |
|---|---|
| P-10 Locks and leader election | the stated rule that no protected write, fence raise or saga record sits on a `memory` resource (RR-14's one rule), or `fero recover --unclean` restarting every fence table it held above every token `#locks` has handed out (OPS-07's rule for a restore); then E-24's lock and saga bounds run with a group that can lose its unsynced tail, once without the rule and once with it (RR-12) |
| P-15 Transactions across partitions | the stated rule that the saga library refuses a saga unit with a step, fence raise or end record on a `memory` resource (RR-11's other half, a per-write `persisted` commit, is not open to COMP2: footnote 13, RR-14), and E-24's saga model rerun with a group that can lose its unsynced tail, once without the rule and once with it (RR-11) |
| F-02 Exactly once per attempt | the stated rule that session-bound writes, refusals and fence raises never sit on a `memory` resource, or `fero recover --unclean` starting a new session generation for the group's slots, as a restore does (A-08, E-33); then E-20's bounds run with a lost tail (RR-13) |
| P-06 Pub/sub | the `none` rung built and its failover rule modelled (K-10); then `nats bench` and `nats latency` through E-45's NATS gateway |
| F-08 Deleted rows stay deleted | a restore model with removes; the phase-2 sim monitor seeded with v4's two row-comes-back bugs |
| F-12 Majority loss | a model of unclean recovery with lock fence tables, the `memory` rung (K-09) and `par`'s repair; recovery tests in phase 3 |
| F-18 Fail-slow | build and model the slow-leader rule in the controller's form (K-17); then the sim with per-node latency and one dm-delay or io.max run |
| DEV-02 Few interactions | models for COMP2's 81 open pairs: MIN-P's 61 (E-32 pairs.md sections 7 and 9: K-01 to K-28, FORKPIN, WTAIL, SRCMOVE, PREVOTE, RESTORENAME), 11 of the `memory` rung (K-09, K-05) and 9 of `par` (G-15, K-24 and the rest; section 7.6) |
| DEV-03 Model before code | phase-1 models of PreVote and CheckQuorum (Raft's rules that stop needless elections) with voter changes, quiet groups with failure detection, the dir lease and the slow-leader rule; the slot move's smallest TLA+ model re-run for the 85 % mutant bar (G-07); the controller's undecided mutants (G-09); `par` with a voter change (G-15); `pslot`'s placement rules (K-04, K-05); K-07's controller form, K-08, K-09 |
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
| DATA-08 data's perf rides along | CI on a dedicated quiet runner that runs data's perf suite on every change to a data path |
| DEV-06 Layer contracts | LAYERS.md's interfaces and invariants, a timed suite per layer under 30 s, CI in which each repo fixes the other's commit |
| DEV-07 Deterministic | the determinism canary on the real kernel; sim traces checked against etcdraft.tla and the slot-move spec |
| DEV-08 Bug flow | STATUS's weekly bug counts from phase 1 on |
| DEV-09 Shapes fixed early | positions, cursors, record header and layer interfaces fixed; each later interface diff checked to be additive |
| DEP-05 Seeds once | v4's revived-seed-row case as a regression test, with a crash between the catalog entry and the seed rows, and two creators at once |
| DEP-06 Addresses | IPv6 in brackets everywhere, listen apart from advertise, a changed private address |
| DEP-09 The supervisor owns secrets | a supervisor layer above the call for secret, address and dir |
| DEP-13 Small copies | memory pins: an empty process, and 10,000 small rows in 256 MB, with the full `data` copy the design rule asks for beside the worker's index (E-05: 510 to 528 B a small row with both copies) |
| TEST-04 Worlds | L4's bind tests on the config layer |
| TEST-09 App steps in the simulator | the café of "fero test" under `--schedules` on the real kernel, with the planner as a sim client |
| OPS-03 Config | the config tiers kept; range and cross-key tests once `fero.alter('#meta')` is built |
| OPS-09 One owner per dir | V4-59's tests ported, and a wrong-project test |
| OPS-11 Debugging in production | the recorder in L0's format, with one recorded run replayed in the sim; later the metrics, trace context and slow-op log |
| OPS-12 Upgrades both ways, and the fold's version | the record header with A-10's five fixed values for the fold version; a roll across two builds and two data versions with F-21's hashes equal |

*A build and a measurement: phase 2 (32).*

| Requirement | What closes it |
|---|---|
| P-01 Live shared state | the persisted-write p99 pin on the real kernel (PERF-08's pin), and example 02 on three real processes |
| P-11 Counters and rate limits | the pin for a conditional op at the writer on the real L2 (PERF-10's pin) |
| P-22 Delayed jobs, waiting takes, priorities | the writer-time stamp op in L2 (a phase-1 API shape), then the waiting-take wake pin |
| PERF-01 Fair comparison | a real kernel behind E-45's gateways, each competitor's own tool in the same hold; the native step for the single-client tail rows |
| PERF-02 Redis 7 | memtier through the RESP gateway: about 92,000 persisted SETs a second at 200 connections with p99 under 4.9 ms; the pipeline-16 default test lines need the `memory` rung or the native step |
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
| PERF-14 Never widen | a dedicated quiet runner, each bar entered as a pin in `npm run perf`, then the CI history |
| DATA-05 Views are data's operators | data emits per-row `group` deltas and shares equal views; then P-12's pins |
| SC-04 Scale down | the 7-day daily-load-cycle sim with the real mover and its thresholds (phase 4) |
| SC-05 Scale to zero and back | a built wake path (native crc32c, blind writes while the fold catches up) timed at 10 GB, in the two-copy form the design rule asks for, or with the worker holding an index without values ([E-34]: with both copies, 10 GB needs about twice the heap and could not run on the 16 GB box); then sleep and wake with disks kept and lost |
| SC-11 Hosted, many tenants | two projects on the deploy target's volumes under E-35's load, one at quota; 1,000 sleeping projects on the box |
| DEP-07 One public address with TLS | the client test through one proxy address with a TLS terminator |
| DEP-10 Contracts before the roll | the deploy test with a changed rule and A-10's five fixed values for the fold version |
| TEST-08 Captures line up | the viewer test on v5 captures |
| OPS-04 Debugger | the DOM gates on v5 captures and a live cluster |
| OPS-05 Mixed versions | the roll test across two kernel builds |
| OPS-06 Security | door and TLS tests, and a rotation under load |
| OPS-07 Backup, restore and point in time | a restore to a past position with an outside token holder, and an export round trip |
| OPS-10 Per-user access | the hostile-client suite, a revocation under load, the 2 µs pin |
| OPS-13 Erase | erase tests across every store; a deleted project's bytes unreadable once its key is gone |
| OPS-14 A shared tier keeps projects apart | a key per project at rest and a cross-project read attempt |

*A build and a measurement: the native step (1).*

| Requirement | What closes it |
|---|---|
| TEST-10 Same kernel bytes | a Rust core that passes etcd's files, then A-30's guard over 1,000 seeds; or the Rust kernel run as WASM in the sim. raft-rs 0.7.0 cannot run etcd's files (G-24) |

DATA-09 (A native kernel keeps data) left this list: it is met by construction while the design rule holds (RR-17). A-30's twin guard still checks that the Rust core hands `data` the same records the TS kernel would. If the rule is dropped, DATA-09 is open again, and its closer is the differential test of a native fold against data on E-43's stream (1e6 records, state compared).

**Every other row's list** is in its scorecard. The 20 study rows have one `<ROW>.md` each in [judging/rows/](judging/rows), rebuilt with the re-rulings. Each closure row's 148 cells, with their reasons, are in [hybrids/cards.json](judging/closure/hybrids/cards.json). `python3 tools/closure.py card '<changes>' <BASE>` prints the same for any mix (V-15).

## 6. Every other row

"Novel" is the settled count after the re-rulings. "A" is as worded: OUTCOME A.2's place for the 20 study rows, with the MUSTs failed in brackets. "B" is restated, on the loose and the strict DATA-01 reading. "Open MUSTs" is restated, on the loose reading. Computed here (`standings.py`) for the closure rows.

| Row | What it is | Novel | A | B (loose / strict) | Open MUSTs (B) | Why it does not win (strict reading) |
|---|---|---|---|---|---|---|
| COMP2 V=full | COMP2 with every replica a voter | 3 | (4) | in / in | 99 | it ties COMP2 on every count; COMP2 keeps AMENDMENTS' `+lrn` |
| COMP | the study's composite: leaders heal, Z `rejoin` | 3 | 4 (4) | in / in | 100 | 5 SHOULDs against 6: without `par` a group with a bad entry on two replicas can stall (F-22 S) |
| MIN-P+m | COMP2 with `rejoin` in place of `par` | 3 | (4) | in / in | 99 | 5 SHOULDs against 6 (F-22 S) |
| COMP+par C=cent V=full | COMP2 with a separate controller that tracks members by sessions | 3 | (4) | in / in | 100 | 282 pairs against 277: its controller sessions, for no cell. Family A's link-pings ruling decides this: without it the row prices 272 and beats COMP2 (section 7.5) |
| SPLIT | groups that split and merge by size and load, each leader heals | 4 | 1 (3) | in / in | 102 | 1 apart on novel, 5 SHOULDs against 6 |
| DRAFT | DESIGN-V5 as of 2026-11-05 | 5 | 1 (3) | in / in | 100 | 5 novel against 3 |
| MIN-P+par | COMP2 without the `memory` rung | 3 | (5) | out on PERF-04, both | 95 | only `persisted`, which cannot beat JetStream's default by PERF-01's spread rule (RR-04, RR-15); wins if that loss is accepted |
| MIN-P+par V=full | the same, every replica a voter | 3 | (5) | out on PERF-04, both | 95 | as MIN-P+par, which it ties |
| MIN-P+par C=cent V=full | the same with a separate controller | 3 | (5) | out on PERF-04, both | 96 | PERF-04; 269 pairs, 5 more than its twin |
| MIN-P | MIN with groups owned by the project | 3 | 9 (5) | out on PERF-04, both | 96 | PERF-04; let back in, 5 SHOULDs against MIN-P+par's 6 |
| MIN | DRAFT minus the witness, planner, group rule and window dedup; one controller loop | 4 | 9 (5) | out on PERF-04, both | 96 | PERF-04; let back in, 4 novel and 5 SHOULDs |
| RUST | MIN with a Rust core and raft-rs from day one | 4 | 9 (5) | out on PERF-04, both | 97 | as MIN |
| LEAN | MIN where only leaders fold | 4 | 9 (5) | out on PERF-04, both | 96 | as MIN |
| MIN-TS | MIN in TypeScript for good | 4 | 9 (5) | out on PERF-04, both | 94 | as MIN. Once the loss is accepted it has the fewest open MUSTs of the judged rows that are in, so "open MUSTs first" picks it among them. Over the searched mixes, MIN-P+par in TypeScript ties it on open MUSTs and beats it (section 3.2) |
| SIDE | MIN with a native daemon per host | 4 | 9 (5) | out on PERF-04, both | 99 | as MIN |
| RLOG | Raft on log members; a server writes by a committed writer epoch | 4 | 5 (4) | out on PERF-04, both | 96 | as MIN |
| EMB-V8 | SRV with V8 embedded | 4 | 5 (4) | out on PERF-04, both | 99 | as MIN |
| SRV | MIN as a Rust or Go server binary | 4 | 5 (4) | out: PERF-04 / out: PERF-04, DATA-01 | 102 | PERF-04; on the strict reading its servers fold natively (DATA-01) |
| SRV V=full Y=fwd | SRV with every replica a voter, writes forwarded | 4 | (4) | out: PERF-04 / out: PERF-04, DATA-01 | 102 | as SRV |
| SLOG | the earlier log-first draft, with slots | 5 | 5 (4) | out on PERF-04, both | 117 | PERF-04; let back in, 5 novel against 3, so it loses on the novel count (V-13) |
| ISR | Kafka's shape: leader and in-sync set under a controller | 2 | 1 (3) | out on SC-03, SC-04, SC-10, both | 117 | a fixed partition count gives 23 to 53 writers' worth at 64 groups under skew, even with the app split ([E-18], a ceiling); no rule merges a group (structural) |
| LANE | 64 lanes per project | 3 | 9 (5) | out on PERF-04, SC-03, SC-04, SC-10, both | 95 | PERF-04; 64 shared lanes give one resource 23 to 53 writers' worth ([E-18]); no rule removes a lane |
| CELL | 16 cells per resource, re-keyed to grow | 4 | 17 (6) | out on OPS-01, P-07, SC-03, SC-08, SC-10, both | 100 | a re-key refuses old cursors ([E-17], [E-31]); 7 to 15 writers' worth ([E-18]); a write waits for the re-key ([E-17c], counterexample); a person picks the cell count |
| PD | TiKV's shape: split and merge, a controller, timestamps, two-phase commit | 0 | 16 (6) | out: F-22, PERF-04, SC-05 / and DATA-01 | 117 | no checksum per entry, so a committed write is overwritten in 32 states ([E-37]); state on local disks with no tier, so a wake after lost disks keeps nothing; PERF-04 |
| PD+fix | PD with the disk incarnation, an object-store tier and the `memory` rung | 0 | (3) | in / out: DATA-01 | 122 | strict: DATA-01. Loose: 3 SHOULDs against TiKV-TS's 4 |
| TiKV-TS | PD+fix in TypeScript first (ported Raft), with `par`, forwarding and every replica a voter | 0 | (3) | in, **wins** / out: DATA-01 | 122 | strict: DATA-01 (section 3.3) |
| TiKV-persisted | TiKV-TS without the `memory` rung, as a Rust or Go server | 0 | (4) | out: PERF-04 / out: PERF-04, DATA-01 | 120 | PERF-04; wins on the loose reading if the loss is accepted. Its strict DATA-01 failure now carries PD's reason, since PD's rule is tried first (RR-17) |
| OBJ | the object store is the log | 2 | 18 (9) | out on 7 MUSTs, both | 111 | every commit is a conditional PUT, p99 about 80 ms on S3 Standard against 5.7 ms ([E-28]); a store that is down stops writes; about $136 a month against $10 ([E-41]) |
| BUY | fero's upper layers on NATS JetStream; a reference row | 0 | 19 (27) | out on 27 MUSTs, both | 96 | the sim cannot run nats-server's bytes (TEST-10, DEV-07); a retry lands twice once JetStream's dedup window has passed ([E-44]); it cannot beat what it is built on |
| V4 | v4 as it is | 8 | 20 (50) | out on 50 MUSTs, both | 64 | two sells of the last item through two servers both answer ok (P-14, v4 measured); F-01 and F-02 pinned red in v4's own sim |

**DEP-21's written reasons.** DEP-21 asks this page to give a reason for each row that costs more than twice the cheapest at any load.
- The figures are E-41's ([E-41], cited prices) and its price re-check of 2026-11-10 ([recheck/results](experiments/E41-hosted-cost/recheck/results)). The re-check read Fly's and Tigris's prices at the vendors' own docs sources. It bills the upload to Tigris at $0.006 to $0.02 a GB, a rate Fly does not name.
- Ratios are computed here at the same transfer bound (`ratios.py`).
- E-41 did not price the closure rows. Each is given the shape it shares (reasoned): COMP2's family has MIN-P's shape, SRV V=full Y=fwd has SRV's, and PD+fix, TiKV-TS and TiKV-persisted have PD's.

The reasons, load by load:
- **A sleeping free project.** The cheapest row, EMB-V8, costs $0.00. So every other row is "more than twice" it, and a ratio says nothing (E-41 says so too). In dollars every row is under the $2.19 bar:
  - $0.04 for DRAFT's family, SLOG, RLOG and OBJ,
  - $0.19 for MIN's shape (COMP2's family, ISR, V4),
  - $0.23 for SRV's and PD's shapes,
  - and $0.60 for BUY.
  - The spread is the stopped machine's root disk, plus a 1 GB volume for rows that keep their own disk.
- **10 writes a second, Fly, cheapest region (iad).** The cheapest row is DRAFT's shape, $5.17 to $5.54. Over twice that:
  - **OBJ**, $136.02 to $136.39 (24.6 to 26.3 times): every commit window is a PUT, about 26.3 million a month.
  - **SRV** and SRV V=full Y=fwd, $11.97 to $12.34 (2.2 to 2.3 times). **PD** and PD's family, $18.64 to $19.01 (3.4 to 3.6 times). **BUY**, $16.14 (2.9 to 3.1 times). In these the app runs on machines of its own beside the servers, and PD adds three placement machines.
  - PD's family also uploads about 26 GB of log a month to its tier, $0.16 to $0.53. With the placement process inside the three stores and one app machine, PD's shape costs $9.58 to $10.11 (about 1.8 to 1.9 times). That is why RR-06 kept PD's DEP-21 open.
  - COMP2's shape is $7.52 to $7.89 (1.4 to 1.5 times), under the $10 bar in iad and ams.
- **10 writes a second, AWS** (E-41's cited prices, not re-read): OBJ 20.5 times, PD 3.9, SRV 2.5 and BUY 2.5. The causes are the same as on Fly.
- **5,000 writes a second, Fly.**
  - In E-41, only OBJ is over twice the cheapest (17.5 times EMB-V8's $79): one PUT per 10 ms window.
  - With the upload billed, BUY ($136), which keeps no log in the object store, becomes the cheapest row. Every other row but OBJ costs $158 to $393: 1.2 to 1.5 times BUY at $0.006 a GB, and 2.5 to 2.9 times at $0.02 a GB. The reason is the upload itself, 13,140 GB a month.
  - BUY is E-41's reference row and never the base of its ratio. Against EMB-V8, the cheapest row that is not the reference, only OBJ is over twice (4.8 to 9.3 times).
  - Compressing the log, or uploading compacted state, would cut it (reasoned).
- **5,000 writes a second, AWS.** OBJ is 2.3 times the rest on S3 Standard. Every three-copy row pays about $526 of traffic between zones, so the others end within 1.1 times of each other.
- **COMP2 in other regions.** At the top of its range it passes $10 in São Paulo ($11.86 to $12.52), Johannesburg ($10.70 to $12.54), Tokyo ($9.81 to $10.46) and Singapore or Sydney ($9.55 to $10.21) (V-04). Same-region traffic is free only for a Fly organization on granular data-transfer rates.

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

A decisive difference is one that could change the ranking.
- The closure judges agreed on every cell both scored. On four crossing cells (P-15 M and S on PD+fix and TiKV-TS) only judge 2 raised the crossing, and the referee upheld it (section 4.5). Those four set TiKV-TS's P-15 (S), and so its SHOULD count. They also gave the trace that RR-11, and then RR-12 and RR-13, carried over to COMP2's family.
- The leading rows barely differ on cells. COMP2 differs from COMP and from MIN-P+m on one SHOULD, F-22 (S). From COMP it also differs on DATA-09, a MUST rule 3 does not count. From COMP+par C=cent V=full it differs on one MUST, PERF-12 (computed here, `twins.py`).
- **So COMP2's lead over COMP and MIN-P+m rests on one judged cell, F-22 (S),** which family A's two judges scored met. Its lead over the separate-controller twin rests on the pair count (282 against 277), and so does the order between COMP and MIN-P+m (283 against 264).
- The pair counts come from the reads and writes in [mechanism-list.json](judging/mechanism-list.json). Those were written once. A second agent checked them only for the most-carried pairs and the pairs between novel mechanisms ([pairs.md] section 9).

### 7.2 The re-rulings since draft 2, and what each changed

| Id | What was asked | Ruling | What it changed |
|---|---|---|---|
| RR-01 | F-05 (M) as worded, the 15 Raft study rows | fails → open | outcome A's top: the Raft rows lose a failure |
| RR-02, RR-03 | P-05 (M) as worded, 18 rows | fails → open | outcome A's top, with RR-01: DRAFT, SPLIT and ISR level |
| RR-04 | PERF-04 (M), the 12 `persisted`-only rows | fails, on PERF-01's spread rule now, not "C is a floor"; gap 0.33 → 0.39 (RR-15 later set 0.07) | no order above place 16 of outcome A |
| RR-05 | F-02 (M), DRAFT, LANE, SPLIT | met → open: the dedup window was never checked beside fence tokens (E-32's crossing) | met counts fall by 1 |
| RR-06 | DEP-21 (M), PD: fail it? | rejected: kept open ($9.58 to $10.11 with placement inside the stores) | nothing |
| RR-07 | DATA-01 (M), PD: fail it? | rejected: kept open; the strict reading named as the user's | nothing as the cells stand |
| RR-08 | F-17 (M): fail only on the star reading? | rejected: kept failing; the clique reading named as the user's | nothing as the cells stand |
| RR-09 | DEP-21's free bar, the MIN-shaped rows | rejected: judged asleep; the awake reading named as the user's | nothing as the cells stand |
| RR-10 | DATA-01 (M), SRV and PD | records the user choice: on the strict reading both fail by structure | the matrix's DATA-01 column |
| RR-11 | P-15 (M), the saga rows with the `memory` rung (DRAFT, CELL, SPLIT, COMP) | met → open | those four and, through the attribution, COMP2's family: one met MUST becomes open each (COMP2 97 → 98); no winner |
| RR-12 | P-10 (M), the `memory`-rung rows (DRAFT, CELL, SPLIT, COMP; MIN-P+m, COMP2, COMP2 V=full, COMP+par C=cent V=full) | met → open, reasoned: a lost unsynced tail sends the writer's fence table back | with RR-13 and RR-17: COMP2 98 → 99 open; COMP 98 → 100, CELL 98 → 100, DRAFT 99 → 100, SPLIT 101 → 102; no winner |
| RR-13 | F-02 (M), CELL and COMP, and the same four closure rows (DRAFT and SPLIT were open by RR-05) | met → open, reasoned: the lost tail can lose a refusal or a session floor | as RR-12 |
| RR-14 | RR-11's closer, for rows that set their rung per resource | accepted: only refusal is open to them; with RR-12 and RR-13, one rule: locks, fences, sagas and session-bound writes never sit on a `memory` resource | no cell |
| RR-15 | PERF-04's gap (0.39) | accepted: the fail stands; gap 0.07 (0.323 ms with no network, 0.326 ms with the client's hop, against 0.303 ms) | outcome A: the PERF-04 rows' sums 1.71 → 1.39; PD 16th, CELL 17th |
| RR-16 | the Q `mix` reason for PERF-04 | accepted: the cell stays open; the reason is restated against RR-04's bar | no cell |
| RR-17 | DATA-01's strict encoding | accepted: written out (two cases fail; rows that leave the fold to a design choice stay open); COMP2's design rule recorded on A1 to A7; TiKV-persisted carries PD's reason | DATA-09 met on the seven rows (an override); COMP2 −1 open; no winner |
| RR-18 | DATA-01 (M) for TiKV-TS on the loose reading: fail it? | rejected: open on the loose reading, fails on the strict and middle ones; reason restated; design rule on B1 (DATA-09's test binds from the TypeScript phase on) | no count |
| RR-19 | TEST-07 (M) on the M `kw` rows: open it? | rejected: stays met; one test owed in the build | nothing |
| RM-01 | does SPLIT carry the merge? | yes | SPLIT 278 → 295 pairs |
| RM-02 | are log replicas novel? | no: TiKV's witness, read at the source | DRAFT 6 → 5, SPLIT 5 → 4, CELL 5 → 4, LANE 4 → 3 |
| RM-03 | is `par-repair` novel? | no (PAR is its precedent) | nothing |
| RM-04 | add planner hints to the controller rows? | no: they hold the hint path in mechanisms they have | nothing |
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

The matrix's flips are explained in section 3.2. Here is OUTCOME's sweep run over the 31 rows, from each of the two winners (computed here, `sweep31.py`; rerun for this page with the same results).

**From COMP2 (restated, strict, no loss).** COMP2 keeps the win in all of these:
- with every open SHOULD counted as met, or as not met
- with SHOULDs first, or with open MUSTs first
- with `par-repair` counted novel (4 against MIN-P+m's 3: one apart, and COMP2 has one more SHOULD; V-18)
- with the other choice on N_res, region scope, the shared tier or the fsync figure
- with DEV-01's or PERF-08's reading flipped
- with 15 of 16 SHOULDs left out one at a time
- in 55 of 62 lines that give one row 2 more or 2 fewer novel mechanisms.

The sweep's F_w and F-06 lines test nothing here. Among the 31 rows' cells, the F_w flag sits only on CELL's OPS-01, and no cell depends on F-06. F_w above 135 is a separate, reasoned case that does move the winner (section 8, item 5). COMP2 loses the win in these lines:

| The change | Winner then | Why |
|---|---|---|
| PERF-01 losses accepted | MIN-P+par | the `memory` rung buys no cell, and 264 pairs beat 277 |
| DATA-01 read loosely | TiKV-TS | 0 novel against 3 |
| F-07, P-02 or P-13 read the other way | level, every row out: DRAFT, SPLIT, COMP, MIN-P+m, COMP2, COMP2 V=full, COMP+par C=cent V=full | one MUST failed each, with no gap |
| F-22 (S) left out | MIN-P+m | `par`'s only gain goes, and 264 pairs beat 277 |
| COMP, MIN-P+m or COMP+par C=cent V=full given 2 fewer novel mechanisms | that row | 1 against 3 |
| COMP2 or COMP2 V=full given 2 fewer, or 2 more | that twin alone, or the other twin | it only splits the twins |

**From TiKV-TS (restated, loose, no loss).** TiKV-TS keeps the win with every open SHOULD counted either way, and with `par-repair` counted novel (1 against COMP2's 4). It also keeps it the other way on every user number, and with any one SHOULD left out (16 of 16). 55 of 62 novel-count lines keep it. It flips in these lines:
- SHOULDs first, or open MUSTs first: COMP2, with 6 SHOULDs against 4 and 99 open against 122. The SHOULD lead rests on three TiKV-TS SHOULDs nobody judged (section 8 item 3).
- DATA-01 read strictly: COMP2.
- PERF-01 losses accepted: TiKV-persisted.
- F-07, P-02 or P-13 read the other way: every row out, with the seven rows above plus PD+fix and TiKV-TS level.
- Any of COMP, MIN-P+m, COMP2, COMP2 V=full, COMP+par C=cent V=full or PD+fix given 2 fewer novel mechanisms: that row.
- TiKV-TS given 2 more: PD+fix.

**One AMENDMENTS 1.3 clause kept as worded, the rest restated** (computed here, `keepone.py`):

| Clause kept as worded | Strict reading | Loose reading |
|---|---|---|
| SC-03 and SC-10 | every row out; DRAFT, SPLIT and the 5 COMP-like rows level (2 MUSTs, 1.32) | the same, with PD+fix and TiKV-TS |
| F-17 | every row out; the same 7 rows level (1 MUST, no gap) | the same, with PD+fix and TiKV-TS |
| F-15 | SPLIT: only DRAFT and SPLIT stay in, and only while their restore mark has no home in the store | TiKV-TS: its F-15 is open, since writes and elections use the local store |
| P-05, SC-05, SC-08, SC-13, F-10, DEP-21 | COMP2 | TiKV-TS |

### 7.5 Close calls in the mechanism count

- **`par-repair`'s novelty.** Only one counter judged it: counter a said not novel, with PAR as precedent. Counter b was never given it. E-37's "+1 mechanism" counts a carried mechanism, not a novel one. RM-03 keeps it not novel.
  - Counted novel, COMP2 has 4 against MIN-P+m's 3. It still wins under rule 3 as written: one apart, one more SHOULD.
  - Only a reading of rule 4 as "fewer novel mechanisms first, whatever the gap" would pick MIN-P+m.
- **Log replicas' precedent.** TiKV's witness (RFC 0106, kvproto's `is_witness`, raftstore's election priority) has the same state, rules and role, read at the source (RM-02). This moved DRAFT, SPLIT, CELL and LANE down one each. COMP2 carries no log replicas. Taken with SPLIT's merge (RM-01), COMP keeps the 20-row win. Without the merge, SPLIT would have won it.
- **Planner hints.** COMP carries a planner-hints mechanism. COMP2 takes hints as inputs to its controller, and RM-04 found that the controller's mechanisms already hold every hint rule. Counted on COMP2 too, its C-axis margin over leader healing falls from 19 pairs to 3 (296 against 293, `hints.py`). It still leads.
- **Learners under V `full`.** The two family-A judges split. The referee kept learners as the healer's catch-up stage, since the controller adds a replacement as a learner and promotes it ([E-16]). Without them, COMP2 V=full would price 8 pairs under COMP2 on identical cells (family A's follow-up). Family B ruled the same for TiKV's rows.
- **Link pings, and the separate-controller twin.** Every Raft row carries link pings, COMP2 included (mechanisms.json's condition).
  - The 5 pairs between COMP+par C=cent V=full and COMP2 are its controller sessions, the one mechanism COMP2 lacks. The two rows differ in cells only on PERF-12 (M), a MUST.
  - Before family A, the separate-controller rows did not carry link pings. Family A's referee added them (both judges agreed), which gives that row 10 pairs.
  - Without that ruling it prices 272. It would tie COMP2 on novel (3) and SHOULDs (6), and beat it on pairs (computed here, `pairs.py`). So COMP2's lead over that twin rests on this one ruling.
  - PD's family carries link pings since RM-08 (+9). ISR, SLOG and OBJ do not (RM-09).
- **Counter b's stricter count, and `dir-lease`.**
  - Counter b judged the `memory` rung, planner hints and the leader-form slow-leader rule novel (MECHANISMS 4.5). COMP2 carries only the first. MECHANISMS section 2 gives MIN-P 2 by counter b. So, counted b's way, COMP2 has 3 and COMP 5 (reasoned from that table), which widens COMP2's lead.
  - `dir-lease` is novel because no counter placed a precedent. The HBase lead is unchecked. It is in 16 of the 20 study rows (24 of the 31), COMP2 among them, so no order changes.

### 7.6 DEV-02 and the models

**COMP2's pairs, and where each sits** (computed here, `partners.py` and `ratios.py`).
- COMP2's 277 pairs are MIN-P's 252, which E-32 placed ([pairs.md] section 4), plus 25.
- 12 of the 25 are the `memory` rung's with MIN-P's mechanisms. E-32 placed them for COMP, with the same partners: 11 open under K-09 and K-05, and 1 argued independent (with `forks`).
- 13 are `par-repair`'s. Of those, 4 sit in E-37's model with `par`'s own rules: Raft's log, votes and commit, and the stand-down guard RF-02 counts. (Reasoned here: E-37 holds those rules, and E-32 had no `par` row to place.)
- The other 9 are open. Six pair it with the journal, the tier, the disk incarnation, the dir lease, the recorder and the snapshot. Three pair it with the `memory` rung, the group config and the controller's commands. The last two are G-15's voter change.

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

SPLIT's 17 merge pairs (RM-01) and PD's 9 link-ping pairs (RM-08) came after E-32, and are counted open here. E-32 did not place the pairs of TiKV's closure rows beyond PD's own.

- **DEV-02's MUST** (each pair inside one model, or shown independent) is **open for every row**. Every row has open pairs, and no model found a counterexample.
- **Its SHOULD** (at most 10 pairs) is **not met by any row**. The smallest is BUY's 12, and every v5 row that runs its own kernel carries 144 or more (V4 carries 52).
- **COMP2's open pairs** sit mostly where a mechanism was never built or modelled. That is the `memory` rung (K-09), `par` beside a voter change and the journal (G-15, K-24), and hints (K-08). It is also the slow-leader rule (K-17) and quiet groups (K-22). The rest spread over about two dozen other closers ([pairs.md] sections 7 and 9).

**The composed model of the riskiest crossing** ([crossing/README.md]).
- It ran one slot move from group A to B, with a leader change, a voter swap and a log drop behind a snapshot. The dedup state the move carries came too. They ran in any order.
- Every property held on 28 bounds explored in full (up to 2,612,006 states each).
- It found one counterexample neither single model could: in 6 steps, a write is both applied and told "refused". The fix is E-20's floor rule on one more path (the Raft thesis, section 6.3).
- It caught 95 of 136 mutants (70 %), under DEV-03's 85 %.
- It models leader healing and client sessions. It covers a controller row such as COMP2 only through a reduction a second agent checked. The controller changes a group's config only through the group's leader, under healing's own guards ([pairs.md] pairs 216 and 227; reasoned).
- Left out: the controller that heals and moves at once (K-07), the `memory` rung (K-09), `par` (G-15, K-24) and a restore. Also left out: writer time, the tier, many resources and 4,096 slots, hints, the slow-leader rule and quiet groups.

### 7.7 In short

- **Against rows nobody judged,** the answer is settled among the options judged rows hold. On the strict reading no mix beats COMP2 without at least 4 guessed cells, and the best rows were judged blind.
- **Against options no judged row holds,** three (D `keys`, X `rampv`, R `vsr`) could still beat COMP2 once tested and judged. A fourth, Y `proxy`, bears only on TiKV's shape (section 4.7).
- **Against its judged neighbours,** COMP2's lead is thin. It has one judged, model-checked SHOULD over COMP and MIN-P+m. It has 5 pairs over the separate-controller twin, which rest on family A's link-pings ruling. And its pair count comes from one agent's reads and writes.
- **On the loose reading,** rule 3 has no winner from 1 to 9 and from 12 to 38 guessed cells. At 10 and 11, the one unbeaten shape rests on 10 or 11 guessed cells.
- **The answer as a whole turns on one reading the user owns,** DATA-01, with a design rule COMP2 must keep on the strict side.

## 8. What the user must confirm

Items 1 to 14 are AMENDMENTS' list ("For the user to confirm"), in its order. F_w, N_res, PERF-01 and the shared tier are folded into the item that names them. Items 15 to 23 are the readings the referees and this page added. **Bold** marks an item that can change the winner.

| # | The question | In force now | The other way | What changes if the user picks the other way |
|---|---|---|---|---|
| 1 | F-06: may a leader's clock jump cause a failover? | no: writer time is the median of the members' clocks (A-23) | yes: CockroachDB's guard | no cell depends on it; no winner moves. Both need 7 rules; the guard failed over on every leader clock jump (60 of 60, [E-21]) |
| **2** | **PERF-01: which competitor-default test lines may fero lose, by name?** | **none** | **JetStream's default single-publisher test line (and PERF-02's and PERF-05's default test lines)** | **strict: MIN-P+par (the `memory` rung goes); loose: TiKV-persisted. Neither rung has a winning number yet: E-02's `memory` rung read 0.57 ms in TS and 0.33 ms in Rust with no client hop, against a bar of about 0.30 ms at p99 and about 4,340 acks a second** |
| **3** | **Rule 3's order (REQUIREMENTS rule 4)** | **as written: the novel count first (when 2 apart), then SHOULDs, then pairs** | **SHOULDs first** | **strict: COMP2 either way. Loose: COMP2, but only on SHOULDs nobody judged for TiKV-TS (note a)** |
| 4 | DEP-17: may a platform hint change membership? | hints are inputs to the controller's loop, under A-20's re-checks | a hint changes membership directly | no cell depends on it; K-08's model is owed either way |
| **5** | **SC-03 and SC-10, and F_w** | **restated with the app split; F_w = 64** | **as worded; or F_w above 135** | **as worded: every row out (section 7.4). F_w above 135: the slot rows' own restated cells fail. Split rows state no fixed ceiling, so SPLIT wins on the strict reading and TiKV-TS stays on the loose one (reasoned from the cells). At the 1,024-slot fallback a slot row states 72** |
| 6 | P-05: restate the delivery bar? | restated: a window per room and about 1,000 sockets a core | as worded | no winner moves: as worded P-05 is open, not failed, for all but OBJ and V4 (RR-02, RR-03). The choice sets the bar the build must meet |
| **7** | **F-17: restate, or add an election rule?** | **restated: "a connected majority that includes an up-to-date replica"** | **as worded; or a new election rule** | **as worded: every Raft row fails, every row is out (section 7.4). A new rule adds 1 novel mechanism to every Raft row alike, so no order among them changes. See item 19 for the reading of "connected majority"** |
| 8 | F-05's handover bar and SC-08 (b) | F-05 open either way (RR-01); SC-08 (b) restated | cut the slot move to one or two commits | no winner moves. The evidence: etcd misses 10 ms at the tail here, inside the disk's own stalls; one commit measured at most 4.7 ms, not yet modelled ([E-13]) |
| 9 | SC-13's "small", and N_res | "few slots touched"; N_res = 100,000 | per-slot state priced per touched slot; another N_res | no winner moves. An idle `pslot` resource is 0.4 to 1.2 KB at 1 to 10 touched slots. Per-slot state is about 85 B a slot, so it passes 2 KB at about 20 touched slots and is about 8.5 KB at 100 ([E-36]; V-07) |
| 10 | P-09 and P-11 (D9): does "an empty take writes nothing" rule out "append every refusal"? | yes: `forward.once` | append every refusal (3 fewer rules) | no winner moves |
| **11** | **F-15: may a slot move wait while the object store is down?** | **yes (restated)** | **no** | **among judged rows: SPLIT (strict), TiKV-TS (loose). SPLIT wins only because DRAFT's and SPLIT's restore mark has no home in the store yet. COMP2 with its mark's home left open the same way (S `jrnl +tier`) keeps 3 / 6 / 277 and passes, on 9 guessed cells (computed here, `s10.py`). So this item is mostly about where COMP2's mark lives, which nobody modelled** |
| 12 | A-23's agreement guard: when most clocks are wrong, stop or keep writing? | stop (9 rules) | keep writing by a wrong time (7 rules) | no winner moves; without the guard, 104 rows early, 370 late and 2 early lock grants in 30 runs ([E-21]) |
| 13 | SC-15: is 1.18 and 1.26 times against a 1.2 bar met? | open | met | no winner moves |
| 14 | J and a tier shared between projects (OPS-14) | yes, J says so | no | outcome B: no winner moves (COMP2, TiKV-TS). Outcome A: ISR alone first on the strict reading; ISR, PD+fix and TiKV-TS level on the loose one (31 rows) |
| **15** | **DATA-01: may a server fold rows in another engine once a test proves it equals data?** | **the cells follow the judges' "yes" (RR-07)** | **no: only data's own code folds on writers and followers (RR-10, written out in RR-17); or the middle reading, data's lane or a tested port of it; or a word-for-word reading that also fails any LSM store and any H `srv` row with a native server** | **"yes": TiKV-TS. "No": COMP2, with its design rule. Middle: COMP2. Word for word: COMP2 up to 3 guessed cells (note b). BRIEF item 6 leans "no"** |
| **16** | **May a row with more open MUSTs outrank a better-tested one on counts alone?** | **yes: rule 3 never counts open MUSTs** | **a guard: open MUSTs counted first, or a cap** | **loose: COMP2 (99 open against 122). With the loss: MIN-TS among the 31 judged rows. Over the searched mixes: see note c** |
| **17** | **DEP-21's free bar: judged for a sleeping project, or also one awake all month?** | **asleep: DEP-21's first load is "a sleeping free project" (RR-09)** | **awake all month** | **COMP2's family is $0.15 over; no cell fails on price alone (RR-09). If a judge ruled that structural, SPLIT would win (note d)** |
| 18 | DEP-21's place and price | J's first regions (iad, ams); subscribers inside; granular transfer rates | other regions; subscribers outside; no granular rates | no cell fails: DEP-21 stays open. COMP2's shape passes $10 at the top of its range in São Paulo, Johannesburg, Tokyo and Singapore or Sydney. Subscribers outside who each get every write add $52.56 a month to every row ([E-41]) |
| **19** | **F-17's "connected majority": star (one server with two-way links to a majority) or clique (a majority in which every pair talks both ways)?** | **star (E-38's, the judges')** | **clique (RR-08)** | **outcome A only: the Raft rows' F-17 becomes open as worded, and DRAFT and SPLIT lead with 2 MUSTs (with PD+fix and TiKV-TS on the loose reading). The 2E clause waits on the sweeps re-run with CheckQuorum every E/4** |
| **20** | **The "other" readings: F-07 (is the two-voter window a stated limit or a failure?), P-02 and P-13 (are the expiry and presence bounds read by writer time?), DEV-01's bar (below v4's 13, while v4's settled count is 8), PERF-08's phase for OBJ, BUY and V4** | **the proposed readings** | **each read the other way** | **any of F-07, P-02 or P-13: every one-writer row fails it, every row is out, and the leading rows are level. DEV-01 and PERF-08: nothing moves** |
| 21 | Region scope (SC-14) | a group's voters in one region; writes homed in several regions are out of scope for v5 | writes homed in several regions | no cell moves now; SC-14 becomes WAN bars, and SPACE's R `epax` and O `hlc` come back |
| 22 | The fsync figure every latency bar is also stated against | a cited figure | another | no winner moves; E-01 could not prove this box's flushes reach the host's disk (G-22) |
| 23 | The mechanism close calls (MECHANISMS 4.5; RM-03 to RM-07; family A's mechanism rulings) | as settled | counter b's stricter counts; `dir-lease`'s HBase lead accepted; link pings not added to the separate-controller rows | no winner moves on the first two (section 7.5). Without family A's link-pings ruling (both judges), COMP+par C=cent V=full prices 272 and beats COMP2 by 5 pairs |

**Notes to the table.**

- **a (item 3).** On the loose reading COMP2 has 6 SHOULDs against TiKV-TS's 4. But three TiKV-TS SHOULDs nobody judged: P-22, DEV-05 and OPS-11 (S) are open for it, not "not met".
  - If two came out met, the SHOULDs tie and the novel count picks TiKV-TS.
  - With every open SHOULD counted met, TiKV-TS has 14 against COMP2's 13.
  - So this is no independent support for COMP2.
  - AMENDMENTS' "COMP follows rule 4" is out of date. `par-repair` is not novel (RM-03), so `par` joins under either order. A witness now costs pairs only (RM-02), and its DEP-15 (S) stays open, so it does not join.
- **b (item 15).** "Yes" gives TiKV-TS, tied with its native twin. "No" gives COMP2 with its design rule that its Rust core never folds rows (RR-17; section 3.3). The middle reading ("data's lane or a tested port of it") gives COMP2 with no design rule needed. Word for word (also failing any LSM store and any H `srv` row with a native server): COMP2 still leads up to 3 guessed cells. Rule 3 circles from 4 to 11, and from 12 up SPLIT2 rows that rest on 12 or more guesses are unbeaten (section 4.4).
- **c (item 16).** Over the searched mixes, on both readings:
  - Without the loss: COMP2 in TypeScript for good (3/6/277, 98 open, one guessed cell), with up to 6 guessed cells allowed (section 3.2).
  - With the loss: MIN-P+par in TypeScript for good (3/6/264, 95 open, no guessed cell), with up to 9 allowed. It ties MIN-TS on open MUSTs and beats it by rule 3.
  - Past those limits the rule moves to rows that lean on guesses (section 3.2).
- **d (item 17).** MIN's shape (COMP2's family) costs $2.34, over the bar by its volume's $0.15.
  - SRV's $4.53 and PD's $6.72 are over too. DRAFT's family is at $2.19.
  - If a judge ruled the volume structural, COMP2's family and the separate-server shapes would go out, and SPLIT would win (reasoned; V-05).
  - At Fly's 730-hour month one always-on machine is about $2.22, so every row with one is about 1 % over.

**The bold items, in one list.** This page's frame is the strict DATA-01 reading, the clauses restated and no loss accepted.
- **Another winner on this frame:** item 2 (the PERF-01 loss: MIN-P+par), item 15 (the loose DATA-01 reading: TiKV-TS), and items 5 (F_w above 135), 11 (F-15 kept as worded) and 17 (DEP-21's volume ruled structural), each of which gives SPLIT.
- **Every row out:** items 5 (SC-03 and SC-10 as worded), 7 (F-17 as worded) and 20 (F-07, P-02 or P-13 read the other way).
- **Only on another frame:** items 3 and 16 (on the loose reading or with the loss), and 19 (as worded only).

## 9. The next step

Settle the readings, and write the models COMP2 rests on. Then build the thinnest slice that runs end to end, break it under chaos, and time it with each rival's own tool. No further judging pass is owed on the strict reading among the options judged rows hold. A critic's lead that passes its experiment (step 3) owes one.

1. **Before code: the user's answers.** At least the bold items of section 8, in the one list under its table: 2, 5, 11, 15 and 17 can name another winner on this page's frame, 5, 7 and 20 can put every row out, and 3, 16 and 19 matter on another frame.
   - If the user picks the loose DATA-01 reading, rule 3 has no winner from 1 guessed cell up, except a 10-guess row at 10 and 11 (section 4.4). A judging pass is then owed on at least the two other rows of the circle. They are TiKV's shape with client sessions and sagas (1/5/253, among TiKV-TS's own twins of that kind), and the same with a dedup window (2/5/252). The answer may still be a circle, so the user should also say how one is broken.
   - Also owed on that reading: family B's lead for the restore oracle after an unclean loss of the controller's majority (OPS-07; B.settled.json). And TiKV-TS's design rule (RR-18) puts DATA-09's differential test in its first build, not only after the native step.
2. **Before code: the models COMP2 rests on, judging-free.**
   - (a) `par` with a voter change, and on one journal per process (G-15, K-24).
   - (b) Once step 6b's timing spike passes: the `memory` rung inside Raft when a majority stops uncleanly (K-09). Model it with RR-14's one rule: locks, fences, sagas and session-bound writes never sit on a `memory` resource. Run E-24's saga and lock models and E-20's dedup model with a group that can lose its unsynced tail, once without the rule and once with it (RR-11 to RR-14).
   - (c) The controller that heals and moves slots at once, with `#meta` down or changing leader (K-07's controller form), and its 9 undecided mutants (G-09).
   - (d) One model every slot row owes: the slot move cut to one or two commits, with its carried set (K-03, K-25). Beside it, the slot move's smallest TLA+ model re-run for DEV-10's mutants (G-07).
   - *Closes, in part:* DEV-02, DEV-03, P-10, P-15, F-02, SC-08, F-12, F-22 (S).
3. **Before code: the critic's four experiments** (section 4.7): D `keys` on E-32's crossing, X `rampv` on E-24's RAMP model, Y `proxy`'s price (loose reading only), and R `vsr`'s costing. Three of them could reorder the top on the strict reading. None needs code. A lead whose experiment passes then needs a judging pass of the cells its axis decides (7 for D `keys`, 12 for X `ramp`, 72 for R `vsr`; section 4.7). It also needs two counters ruling its novelty (DEV-10 (e)) before it can be named.
4. **The slice, in TypeScript.** That is MIN-P+par's shape:
   - E-10's port of etcd's Raft with A-01 and A-02
   - one controller loop on `#meta`'s leader that heals and moves, with A-20
   - one journal per process with its reserve, and a checksum per entry with `par`'s repair
   - `pslot` groups and a 4,096-slot table in `#meta`, with one slot move, its carried set and one give-up decider
   - client sessions with `forward.once` and E-32's three rules
   - writer time as the median, and the `persisted` rung
   - `data` folding the records, with a full `data` copy on every full replica (the DATA-01 design rule). Its memory cost is E-34's two copies, so the wake is timed in that form (SC-05, DEP-13; section 5.4).
   - The `memory` rung comes as a spike on this slice (acknowledge when a majority holds the write in memory), timed in 6b. It stays, and is modelled (2b), only if it passes.
   - Left out: the tier and restore, the `none` rung and relays, hints, the slow-leader rule, merged views.
   - *Closes:* DATA-03, DATA-04, DEV-06, DEV-07, DEV-09, OPS-12 (their phase-1 parts), SC-01, SC-10's slot count.
5. **Chaos.**
   - 1,000-seed sim sweeps with crashes, leader changes, voter swaps, a slot move, a log drop and one bad entry on each of two replicas.
   - E-46's Maelstrom adapter with partitions and pauses (`--concurrency 2n`, an outside pauser, Porcupine beside Knossos), and real Elle on the histories ([E-22b]).
   - E-29's LazyFS power-loss tier, v4's stopsOneByOne harness, and E-38's partial-partition seeds with CheckQuorum every E/4.
   - *Closes:* P-01 (its safety half), F-06, F-07, F-09, F-16, F-17 (restated), F-21, DEP-02, DEP-03, TEST-09.
6. **Timing against the rivals, in the same hold.** PERF-01's rule applies: the same box, at least 3 runs, and the median and spread, under the CPU lock. The floors are measured first (`fio` fdatasync p99 and the loopback round trip). Run through E-45's four gateways ([E-45]) and the competitor drivers of [E-09a2], [E-09b], [E-09c], [E-09d] and [E-09e]:
   - (a) the PERF-08 pin
   - (b) `nats bench js` (PERF-04) on the `memory` rung's spike, the row that decides whether the rung stays (both bars in the kill table)
   - (c) memtier through RESP (PERF-02)
   - (d) etcd's `benchmark` through gRPC (PERF-07)
   - (e) Kafka's own tools against Kafka and Redpanda (PERF-05, PERF-06).
   - PERF-03 waits for the `none` rung.
7. **Failover and moves on three processes.** F-05's pins, the handover, the move's unwritable window, and E-39 rerun with a server grant. *Closes:* F-05, SC-08's (b) pin, F-19, DEP-01, DEP-08.
8. **The native step** (`ts→rs`), for each row TypeScript does not win: PERF-04's default test line, PERF-08's native column, PERF-07's single client.
   - If TypeScript wins them all, stay in TypeScript (L `ts`, section 5.1).
   - On the strict DATA-01 reading the Rust core holds only L0 and L1 and never folds rows. Records cross to `data` in JavaScript (X3's first way, E-03; RR-17's design rule). If a timing shows L2 must go native, COMP2 drops the rule: DATA-09 is open again, and on the strict reading the row fails as SRV does.
   - The Rust core is still open: raft-rs 0.7.0 cannot run etcd's files (G-24).
   - *Closes:* TEST-10 and those native columns. DATA-09 is met by construction while the design rule holds. On the other readings it closes by the differential test.

**Kill criteria: results that would overturn this verdict.**

| Step | The result | The bar | What it overturns |
|---|---|---|---|
| 6b (first) | the `memory` rung's single-publisher result on `nats bench js`, one write in flight, client hop and gateway included | PERF-04 reports both msgs/s and p99 ack, and PERF-01's win is "median better by more than the larger spread". So: p99 below JetStream's 0.55 ms by more than 0.247 ms, about 0.30 ms; and at least about 4,340 acks a second (JetStream's 3,280 plus its spread of 2,287 to 3,342), a mean ack of about 0.23 ms or less. In TS or at the native step ([E-09b]; RR-04). RR-16 restated the card's PERF-04 reason against this bar | if neither, COMP2 fails PERF-04 by measurement, as every row with the rung would; only a loss accepted by name then keeps a row in, and the arithmetic picks MIN-P+par (strict) or TiKV-persisted (loose) |
| 2b | the `memory` rung inside Raft breaks a MUST with no rule that fixes it (K-09; RR-11 to RR-14: P-10, P-15, F-02) | none may | the rung goes: MIN-P+par's shape, which then needs the PERF-01 loss |
| 2a | `par` fails a MUST with a voter change or on one journal (G-15, K-24) | no counterexample | MIN-P+m (COMP2 with `rejoin`) |
| 2c | the controller model needs novel mechanisms that leader healing does not | fewer than 2, and fewer than 19 added pairs | COMP with `par` (leaders heal: 3 novel, 6 SHOULDs, 296 pairs) |
| 2, 5 | a counterexample where a slot move meets a membership change at two member faults (K-01) | none may | every slot row at once (AMENDMENTS G-01): COMP2, MIN-P and DRAFT alike |
| 2d | the slot move's mutants caught | ≥ 85 % (E-15: 39 %; the crossing: 70 %) | below it, DEV-03 fails for every slot row |
| 3 | D `keys` keeps F-02 beside fence tokens and fits DEP-13; or `rampv` holds read atomicity with one novel mechanism; or `vsr` costs fewer pairs | as the critic prices them | COMP2 with D `keys` (8 to 10 fewer pairs), with `rampv` (one more SHOULD) or with `vsr` (up to 10 fewer pairs), after a judging pass of their unjudged cells and a two-counter novelty ruling |
| 4 | the whole-resource cursor at 4,096 slots | ≤ Q-19's 8 KB (E-18 reasons about 32 KB) | fall back to 1,024 slots: 72 effective writers, still above 64 |
| 6a | p99 commit on the real kernel at 50,000 writes a second | ≤ C + 5 ms = 5.73 ms (TS) | over it, P-01 and PERF-08 fail in TS |
| 6c | memtier SET, matched | about 92,000 persisted SETs a second at 200 connections with p99 under 4.9 ms ([E-09a2]) | below it, PERF-02 fails |
| 6d | etcd one-client put | p99 under 1.73 ms ([E-09e]) | over it in TS and native, PERF-07 fails |
| 6e | Redpanda, matched | a TS build keeps at least 62 % of E-02's protocol-free ceiling ([E-09d]) | below it in TS and native, PERF-06 fails |
| 7 | failover after a writer's crash | p99 ≤ 2.5 s in TS. At E = 2 s with 0.25 E jitter the worst draw is the timer's 2.5 s plus about 5 to 20 ms to elect and acknowledge the first write. So E at about 1.98 s or less, or less jitter, keeps it under ([E-13], reasoned) | over it, F-05 fails for every Raft row alike |
| 7 | the move's unwritable window | ≤ 10 ms per move at p99 under 10,000 writes a second (three commits measured 16.7 ms, [E-13]) | if a one- or two-commit move still misses it, SC-08 fails for every slot row, unless (b) is restated |
| 7 | goodput at twice capacity | ≥ 80 % of peak (TS measured 79 to 82 %, [E-39]) | below it, F-19 fails in TS |
| sim, phase 4 | effective writers per resource with the real mover | ≥ F_w = 64 (E-18 predicts 135 at 4,096 slots) | below it, COMP2 fails SC-03 and SC-10 restated, and the split rows (SPLIT; TiKV's shape on the loose reading) are left |

## 10. How this page was made, and what changed

**Tools run for this final page,** from `docs/v5-space`:
- `python3 tools/closure.py check-all`: 4,588 cells with 0 mismatches and 36 overrides, 112 mechanism entries, and 54 constraints.
- `python3 tools/closure_matrix.py` and `python3 tools/judging.py verdict`, run on a scratch copy of `docs/v5-space`. They rebuilt [matrix.md](judging/closure/results/matrix.md), [OUTCOME.md](judging/OUTCOME.md) and outcome.json byte for byte.
- `python3 tools/closure.py mechrow 'Z=par' COMP` (296 pairs) and `python3 tools/closure.py mechrow 'C=cent-co,Z=par' COMP` (277 pairs). `mechrow` reads only the study rows, so `mechrow '' COMP2` fails. `card '' COMP2` and `row '' COMP2` work, since they read the seeds too.
- `python3 tools/closure_ladders.py`, rebuilt for the final recheck so that every cap is tested (section 11.4). The ladder files match the final recheck's own pass at every cap (`allcaps.py`).

**Scratch scripts.** Each imports `tools/closure.py` and, where it ranks, judging.py's rule 3. None writes a study file. They live in this session's scratchpad, not in the repo, and are not kept. A later reader can rebuild them from the descriptions here.
- New for this page, in `/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad/final/`:
  - `analyse.py`: rule 3 pair by pair at each cap, the beaters of COMP2, TiKV-TS, MIN-P+par and TiKV-persisted, the circles, and "open MUSTs first" over the searched mixes.
  - `twins.py`: COMP2's and MIN-P+par's twins on L, the cell differences between the leading rows, and TiKV-TS's native twin.
  - `extra.py` and `wcycle.py`: the native twin's reach, the 4-guess beaters, and the strict ladders with DATA-01 read word for word.
- Rerun from draft 3 on today's files, in `/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad/verdict3/`: `standings.py`, `comp2cells.py`, `sweep31.py`, `keepone.py`, `clique.py`, `seeds.py`, `aflips.py` and `gaps.py`.
- Also rerun, in `/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad/v3-revise/`: `dump.py`, `a4a7.py`, `s10.py`, `middle.py`, `matrix_pw.py`, `worded.py` and `rr04.py`.
- Draft 3's other scripts were not rerun. `partners.py`, `hints.py`, `ratios.py`, `pairs.py` and `a5.py` gave figures the rulings did not touch: pairs, prices and the attribution's history. `beaters.py`, `pairwise.py`, `s3.py` and `celldiff.py` were replaced by the new scripts above, and `p10.py` by RR-12 and RR-13. `st.py` is the shared tally the rerun scripts import.

- The final recheck's scripts, in `/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad/v4-recheck/s/`: `allcaps.py` (rule 3 at every cap), `of2.py` ("open MUSTs first" at every cap), `wfw.py` (the word-for-word strict reading at every cap) and `worded.py` (the as-worded mixes). Like the others, they are not kept.

**What changed from draft 3.**
- **The referee's rulings (RR-12 to RR-19; section 11.3).** COMP2's open MUSTs went from 98 to 99: P-10 and F-02 opened, and DATA-09 is now met by the design rule. Its met MUSTs went from 34 to 33, so the loose-reading gap to TiKV-TS is 23 open MUSTs, not 24. PERF-04's gap went from 0.39 to 0.07, so the PERF-04 rows' sums went from 1.71 to 1.39, and PD now ranks above CELL in outcome A. The design rule is now ruled and recorded, not "unruled".
- **The search fix (commit bcb9afc).** The search now seeds from all 31 judged rows, and the ladders apply rule 3 pair by pair at caps 4 and 6 too. The strict circle now starts at 4, not 5. The loose ladder now counts 7,973 rows in, not 15,432. The hand-built shell is now part of the search.
- **The fresh reader's findings R1 to R14** ([VERDICT.review3.json](judging/VERDICT.review3.json), key "recheck"):
  - R1: three unheld options, not four, could beat COMP2 (0, 4.7, 7.7).
  - R2: with the loss, "open MUSTs first" over the searched mixes picks MIN-P+par in TypeScript (3.2, 6, item 16).
  - R3: PERF-04's lowest gap is 0.07, now the ruled gap (2, 3.1, 7.2).
  - R4: which TiKV rows the search reaches (4.3). Since the fix, both are seeds.
  - R5: the K `lib` rows with an LSM, and a word-for-word encoding (4.4, item 15). On today's search the strict circle stays at 4 either way.
  - R6: COMP2's lead over COMP and MIN-P+m rests on one judged cell (7.1).
  - R7: the unjudged as-worded mixes and P-02 (2). R8: the 72 cells are 66 unsupported and 6 crossings (1, 4.5).
  - R9: the design rule's E-34 cost (3.3, 5.3, 5.4, 9 step 4). R10 and R12: the key of terms, and the plain-English pass over the whole page.
  - R11: "pin" now means only a timed test. The DATA-01 rule is a "design rule". R13: item 0.1 now says "Aim for COMP2: build MIN-P+par's shape first". R14: the exact `mechrow` arguments, and the scratch scripts' status (this section).

**What changed from draft 2** (draft 3's record).
- **The question draft 2 left open is closed.** Draft 2 said rows nobody judged could rank above COMP2. The closure pass built about 379,000 mixes (381,087 on the strict reading since the search fix) and judged the 11 best blind. On the strict reading no mix passes COMP2 without at least 4 guessed cells.
- **The answer names the reading it depends on.** Draft 2 kept PD+fix out by asking to re-rule PD's DATA-01. The referee kept that cell open and made the reading the user's (RR-07, RR-10). So the page gives both: COMP2 on the strict reading, which the brief supports, and TiKV-TS on the loose one.
- **Numbers that moved.** COMP2: 274 → 277 pairs (RF-02, RF-03), and 97 → 98 open MUSTs and 35 → 34 met (RR-11). Outcome A's top: ISR alone → DRAFT, SPLIT and ISR level (RR-01 to RR-03). SPLIT: 5 → 4 novel, 278 → 295 pairs (RM-01, RM-02). PERF-04's gap: 0.33 → 0.39 (RR-04). Two-verdict cells: 189 → 169.
- **Draft 2's rivals.** PD+fix is judged (122 open, out on the strict reading). SPLIT2 is 273 pairs as described (269 with N `proc`).
- **The recheck's findings on draft 2 (V-01 to V-18)** were applied where they still bore:
  - V-01 and V-02 landed in section 4.6, and V-03 in section 6 (RR-06). V-04, V-05 and V-06 landed in sections 6 and 8 (items 17, 18). V-07 is in item 9, and V-08 in section 7.4.
  - V-09 is in sections 3.2 and 7.5. The C margin is 19 pairs, or 3 with hints counted on both. A tie would need 19 more on COMP2, and a flip 20.
  - V-10 is in section 7.6's two placement columns, V-11 in section 2, V-12 in section 4.8, and V-13 in section 6.
  - V-14 is in sections 0 and 9: three models COMP2 rests on, plus one every slot row owes. V-15 is in section 5.4, and V-16 in section 1.
  - V-17 was settled by RR-04, which three agents computed. E-01's 481 µs is its per-run median p99, and the pooled table's p99 is 539 µs. V-18 is in section 7.5.
- **Draft 2's section 10** (the first skeptics' findings and its re-rule table) is answered by the re-rulings of section 7.2. The findings themselves stay in [VERDICT.review.json](judging/VERDICT.review.json).

## 11. What the skeptics said

Four skeptics read draft 3, each through one lens, and tried to refute it. Every finding below was checked again before draft 3's revision changed the page. That revision changed no judging file.

This final edit applied the fresh reader's findings R1 to R14 ([VERDICT.review3.json](judging/VERDICT.review3.json), key "recheck") and the referee's rulings RR-12 to RR-19 (section 11.3). Section 10 says where each landed.

### 11.1 Did the verdict survive each lens?

- **The arithmetic.** It survived. The skeptic reran every tool on a copy and got the repo's files byte for byte. Draft 3's revision reran the search and got the same counts and the same winners. What did not survive were claims about why and how surely. The 5-pair lead over the separate-controller twin rests on one ruling, and rule 3 circles where the old ladders printed a winner. Both were fixed.
- **The evidence under the deciding cells.** It survived. Under the readings the page argues, every winner stays. The strict reading needed a design rule on COMP2's own Rust step. RR-11's reason reached P-10 and F-02, and PERF-04's gap was a range. None moved a matrix line.
- **The strongest case for a different answer.** It survived on the page's own frame (strict DATA-01, clauses restated, no loss accepted). The skeptic's main point stands and is now said first: on the cells as settled, the rule names TiKV-TS. The critic's leads remain live threats until tested and judged.
- **Independent derivation.** It reached the same answer. Working from the files before reading this page, it got the same arithmetic on every matrix line. That is TiKV-TS on the cells as settled, COMP2 (tied with COMP2 V=full) on the strict reading, and TiKV-persisted or MIN-P+par with the loss. It leaned to the strict reading on its own, for the same reasons plus SPACE's goal G6 note on PD. Its differences were framing and the ladder's circles, not the winner.

### 11.2 Each finding

The outcomes below are as draft 3's revision recorded them. The rulings and the rebuilt ladders since then changed some of them (section 11.3). Draft 3 called COMP2's DATA-01 design rule a "pin". This table uses the new word.

| Id | What it said | Outcome |
|---|---|---|
| A1 | The 5 pairs between COMP2 and COMP+par C=cent V=full are controller sessions, not link pings; without family A's link-pings ruling that twin (272) beats COMP2 | Holds (`pairs.py`). Fixed in 0, 3.2, 6, 7.5, 7.7 and item 23 |
| A2 | On the loose reading rule 3 cycles from one guessed cell, so the "best member" and the single owed pass are not well founded | Holds at the caps tested then (`pairwise.py`). Tested at every cap, one 10-guess row is unbeaten at 10 and 11 (final recheck, FR1). Fixed in 0, 4.4 and 9 step 1 |
| A3 | The strict ladder's "first by rule 3" from 5 up is the tool's shortcut and is beaten pair by pair; 4 is skipped | Holds: COMP2 at 0 to 3, COMP2 D=win S=jrnl +tier at 4, a cycle from 5. Fixed in 4.4; the tool fix is listed in 11.3 |
| A4 | With no shared tier, "ISR alone first" holds over 31 rows on the strict reading only | Holds (`a4a7.py`). Fixed in 7.3 and item 14 |
| A5 | Only 3,032 cells are a real test; 1,556 are the model's own predictions; it predicted 63 of the 72 judged cells beforehand; all overrides are V4's | Holds (`a5.py`). Fixed in 1 and 4.2 |
| A6 | Four P-15 crossing cells were raised by judge 2 alone, so "agreed on every cell" needs a qualifier | Holds (B.settled.json). Fixed in 4.5 and 7.1 |
| A7 | The sweep's F_w and F-06 lines test nothing on the slot rows | Holds: F_w flags only CELL's OPS-01; no cell depends on F-06. Fixed in 7.4 |
| A8 | RR-11 re-ruled four study rows, and the `memory` rung costs a met MUST rather than buying none | Holds (`celldiff.py`: COMP2 against MIN-P+par differs on P-15 M and PERF-04 only). Fixed in 3.2 and 7.2 |
| A9 | Learners add 8 pairs today (7 when ruled); `dir-lease` is in 16 study rows, 24 of 31 | Holds (`pairs.py`). Fixed in 4.5 and 7.5 |
| A10 | The search never walks out from the 11 closure rows | Holds. A shell of about 21,500 mixes per reading finds no strict beater under 4 guessed cells and one more loose one-guess beater. Fixed in 0, 4.3 and 4.4 |
| F1 | The strict reading as stated fails SRV against X3, catches COMP2's own Rust core and compact rows read word for word, and TiKV-persisted carries SRV's reason | Partly fixed. The referee's own framing fails SRV (RR-10's user choice) and SPACE lists a native server fold as a risk to SPACE's goal G6, so the strict reading stays as framed. F1's reading is added as the middle reading (same winners, `middle.py`). COMP2's design rule is stated in 0, 3.3, 5.1, 5.4 and 9. TiKV-persisted's reason is in 11.3 |
| F2 | RR-11's reason also reaches P-10 and F-02 | Holds as a gap (K-09 names both). Not re-ruled here; stated in 4.8, 5.2, 5.3 and 9, and listed in 11.3 with its effect (99 or 100 open; no line moves) |
| F3 | RR-11's "commit at `persisted`" half contradicts COMP2's per-resource rungs | Holds (footnote 13). Fixed in 5.3, 5.4 and 9 step 2: for COMP2 the closer is refusal |
| F4 | PERF-04's gap is 0.06 to 0.39, not 0.39 | Holds (`rr04.py`: 0.40, 0.23 and 0.07 by how the round trip is counted). Fixed in 2, 3.1 and 7.2; the recorded gap is in 11.3 |
| F5 | The separate-controller rows' extra 5 pairs come from controller sessions | Holds; the same as A1. Fixed with A1 |
| F6 | `par`'s "7 rules, each needed" leaves out the append guard, the END read rule and the mutant score | Holds (E-37, A.settled.json). Fixed in 5.1 and 5.3 |
| F7 | P-10, F-02 and TEST-07 inherit their supporters' gaps, which no judge looked at | Holds. Fixed in 4.8; listed in 11.3 (TEST-07 opened on every M `kw` row moves no line, `middle.py`) |
| F8 | The first kill test needs a msgs/s bar too; the card's PERF-04 reason predates RR-04 | Holds (PERF-01's win is on the median; PERF-04 reports msgs/s). Fixed in 0, 5.2 and the kill table |
| S1 | The headline uses a DATA-01 reading that is not in force | Holds. Fixed in 0 item 1, 1 and 3.3 |
| S2 | The strict reading is applied to TiKV's shape while COMP2 keeps the loose reading's closer for its Rust step | Holds. Fixed by the design rule and the DATA-09 closer (0, 3.3, 5.1, 5.4, 9 step 8) |
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
| I-1 | Make the answer conditional in its first words; cite SPACE's goal G6 note on PD | Holds. Fixed in 0 item 1, 1 and 3.3 |
| I-2 | TiKV-TS's loose DATA-01 cell borrows a native-fold reason, though its TypeScript phase is not native | Plausible; a referee's call, not ruled here. Stated in 3.2 and item 15; listed in 11.3 (its native twin ties it at 0 / 4 / 244 with no guessed cell) |
| I-3 | The ladder's shortcut is not rule 3 above 0 (loose) and 3 (strict) | Holds; the same as A3. Fixed with A3 |
| I-4 | A sixth one-guess beater of TiKV-TS is missed, and one judging pass cannot settle a cycle | Holds (the shell finds it). Fixed in 4.3, 4.4 and 9 step 1 |
| I-5 | Outcome A is not closed against unjudged mixes | Holds (`worded.py`: 16 loose, 13 strict, each on 8 to 21 guessed cells). Fixed in 2 |
| I-6 | The headline should name the twins that tie COMP2 | Holds. Fixed in 0 item 2 |
| I-7 | On the strict reading COMP2's Rust core must not fold | Holds; the same as S2. Fixed with S2 |

### 11.3 How the re-rule list was settled

Draft 3 listed eight items to re-rule. A referee ruled on items 1 to 7 (RR-12 to RR-19, in [rerulings.cells.json](judging/closure/rerulings.cells.json)). The closure rows' cells are in [A.settled.json](judging/closure/hybrids/A.settled.json) and [B.settled.json](judging/closure/hybrids/B.settled.json) as kind "reruled", each naming its ruling. Item 8 was a tool fix. No winner moved on any matrix line or any ladder. No `judging/<GROUP>.settled.json` file was edited.

| # | Item | How it was settled |
|---|---|---|
| 1 | P-10 (M) and F-02 (M) on the rows with the `memory` rung | **Accepted: met → open, not failed** (RR-12, RR-13). P-10 opened on DRAFT, CELL, SPLIT and COMP; F-02 on CELL and COMP (DRAFT and SPLIT were open by RR-05). Both opened on MIN-P+m, COMP2, COMP2 V=full and COMP+par C=cent V=full. A lost unsynced tail sends the writer's fence table back, and can lose a refusal or a session floor. The trace is reasoned only, so the cells are open. Still owed: E-24 and E-20 rerun with a group that can lose its unsynced tail |
| 2 | RR-11's closer, for rows that set their rung per resource | **Accepted** (RR-14). Only refusal is open to these rows. With item 1's closers it is one rule: locks, fences, sagas and session-bound writes never sit on a `memory` resource. No cell moved |
| 3 | PERF-04's gap (0.39) | **Accepted: the fail stands, gap 0.07** (RR-15). True lower bounds from E-01's table are 0.323 ms with no network and 0.326 ms with the client's hop, both above the 0.303 ms bar. Outcome A's PERF-04 sums fell from 1.71 to 1.39. Draft 3 had noted that PD passes CELL once the gap is below about 0.22, so PD now ranks 16th and CELL 17th |
| 4 | The Q `mix` reason for PERF-04 | **Accepted: the cell stays open; the reason is restated** (RR-16). No rung is shown to win JetStream's default test line, and no ceiling is shown either |
| 5 | DATA-01's strict encoding | **Accepted** (RR-17). Details under the table |
| 6 | TiKV-TS's loose DATA-01 cell | **The fail is rejected** (RR-18). The cell stays open on the loose reading and fails on the strict and middle ones. The reason is restated for its TypeScript phase. Its design rule (B1): DATA-09's differential test binds its store from the TypeScript phase on. No count moved |
| 7 | TEST-07 (M) on the 21 rows with M `kw` | **Rejected: it stays met** (RR-19). The worker's copy is built from the same records, and E-06's undo is about 200 times under the 10 ms bar. TiKV-TS was opened on a different ground: its rows live outside `data`. Still owed in the build: time one rerun in fero test with the kernel's own state rewound too |
| 8 | `closure.unbeaten()` and the ladder files | **Fixed.** Details under the table |

**Item 5 in detail (RR-17).**
- The strict reading fails a row only when its own tags put the rows in another engine: F `all(srv)`, or K `kern` with an LSM.
- Rows that leave the fold to a later design choice stay open: a `ts→rs` native step, H `srv` after a Rust core, M `kw`'s compact copy, and K `lib` with an LSM.
- COMP2's design rule is recorded under `pins` on A1 to A7, not on A8. DATA-09 is now met on those rows (an override). The rule's cost is memory (E-34).
- TiKV-persisted now carries PD's reason.
- Left to the user: whether to read DATA-01 word for word (section 8, item 15).

**Item 8 in detail.**
- Commit bcb9afc made `unbeaten()` apply rule 3 pair by pair and report a circle as "none". The search now seeds from all 31 judged rows.
- The referee's rebuild found that `closure_ladders.py` passed its own caps without 4 and 6, and fixed it. `closure_cards.py` now copies `pins` into cards.json.
- The final recheck (FR1) found that the ladder still tested only some caps. `closure.ladder` now tests every cap and prints a run of caps with the same result as one line. The files were rebuilt again.
- The strict ladder: COMP2 at 0 to 3, a circle from 4 to 47. The loose ladder: TiKV-TS at 0, a circle at 1 to 9 and 12 to 38, and a 10-guess row unbeaten at 10 and 11. The two loss ladders never circle.
- `check-all` gives 0 mismatches, with 36 overrides.

### 11.4 The final recheck

A fresh reader rebuilt every output on a scratch copy and checked this page against the files ([VERDICT.review4.json](judging/VERDICT.review4.json)). The answer stood, and no winner moved. It made ten findings, all applied in this final edit:
- **FR1 to FR3:** the ladders tested only some caps, so some thresholds were off. Fixed in the tool, the ladder files and section 4.4. The loose ladder has an unbeaten 10-guess row at 10 and 11 guessed cells.
- **FR2:** "open MUSTs first" over the searched mixes picks COMP2 in TypeScript only up to 6 guessed cells (9 for MIN-P+par with the loss). Fixed in sections 3.2, 5.1 and 8.
- **FR4:** as worded, 20 mixes (17 strict) fail exactly SC-03 and SC-10; four of them fail SC-10 only on a guess. Fixed in section 2.
- **FR5:** the unheld options' guessed cells are 7, 12 and 72 on today's attribution, not 11, 15 and 72. Fixed in sections 4.7 and 9.
- **FR6 and FR7:** one list of the choices that change the winner (under section 8's table), and item 0.8 names its reading.
- **FR8 to FR10:** more terms in the key, one meaning per word ("test line", "mechanism", "saga unit"), and the densest table cells split into notes.

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
[E-34]: experiments/E34-wake-10gb/README.md
[E-36]: experiments/E36-many-resources/README.md
[E-37]: experiments/E37-bad-entry/README.md
[E-38]: experiments/E38-raft-gray-failures/README.md
[E-39]: experiments/E39-overload-storm/README.md
[E-41]: experiments/E41-hosted-cost/README.md
[E-44]: experiments/E44-outside-log/README.md
[E-45]: experiments/E45-drivers/README.md
