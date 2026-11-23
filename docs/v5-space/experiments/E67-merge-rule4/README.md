# E-67: the merger's rule 4 on seeds

2026-11-23. V5-20 item 1 ([DECISIONS](../../../DECISIONS.md)) ships the merger ([MERGE.md](../../MERGE.md)'s O1) in the first build once its rule 4 passes seeded runs. Rule 4 is about a partial's host that fails while a slot move waits. MERGE section 6 item 1 asks for that run: real three-step moves, a new host that starts at its own place, a move that gives up, a partial down while a move to its group waits, and a pick between "a picture carries its moves" and "a ring of frames on every copy" (MERGE 3.7). V5-20 item 2 (a group that cannot be reached keeps serving, frozen) and item 12 (the merger waits at a move; keys by blocks of slots are the fallback) bear on the same run.

**This is a rebuild.** A first run built this study and a skeptic reviewed it. A restart wiped the files before the review's fixes went in. This run rebuilds the study to the same design and takes in every review finding from the start (section 10 lists them). Every number here comes from this run. Section 9 compares them with the first run's.

**Marks.** *(measured)*: timed, three runs, each run alone on the box under a timing lock, a range. *(checked)*: a seeded run with an oracle, here, in [results/](results/summary.md). *(counted)*: a count from a run. *(reasoned)*: an argument; nothing ran it.

## Words

- **Group, slot, partial, merger, cut, frame, picture**: as in MERGE.md section 1. A **copy** is one server's replica of a group's log. Every copy folds the same log, so every copy could make the same partial frames.
- **Host.** The copy that runs a group's partial and sends its frames to the merger.
- **Half.** A slot move's frame at one group: A's **fence** (the slot's rows leave A), B's **open** (they arrive at B), or A's **unfence** (B gave up, and the rows come back to A).
- **Takeover.** Another copy becomes the host, at its own place. The merger drops its **inbound buffer** from the old host (the frames that arrived and were not taken yet). The new host sends a **picture** at its place, then its frames.
- **Rule 4's case.** A picture that passed a half (of a move with rows) whose partner the picture does not hold. In O1's own run this never happened (MERGE 3.2).
- **Join.** The merger takes one group's next frame or picture together with everything it needs, at one cut. Nothing is shown in between.
- **Held.** A group whose next half needs a half from a group that is down (its partial unreachable).
- **Rebuild.** A new merger, with no part. Every group's host sends a picture.

## 0. The answer first

1. **The bug is real** once moves take their three real steps *(checked)*. Under O1's three rules, ‹none_g4›, ‹none_g16›, ‹none_el› and ‹none_st› of 1,000 seeds failed (g4, g16, elastic, stress). Every failing seed had a picture that passed a half. No seed without one failed.
2. **Fix (a), "a picture carries its moves", holds** *(checked)*: 0 of 1,000 seeds failed in each of the four worlds. That is ‹a_checks› checks through ‹a_moves› moves, ‹a_take› takeovers, ‹a_out› outages, ‹a_reb› merger rebuilds (‹a_rebd› of them while a group was down) and ‹a_cases› pictures with rule 4's case.
3. **Rule 4 is two rules, and rule 2 needs two more once moves are real** *(checked)*.
   - Rule 4 itself: the picture names the halves it passed, and the merger joins it with each half's partner at one cut. With a picture's halves joined one at a time (`nojoin`), ‹nojoin_g4› and ‹nojoin_st› of 1,000 seeds failed (g4, stress), and only in seeds that had the case.
   - Rule 2, the pairing: a half's partner can sit behind other halves, which bring their own partners (the **closure**); and each group's window and filter rows must be kept apart. Both failed in seeds that never had rule 4's case. So they belong to rule 2, and O1 had them only in part (section 7).
4. **Fix (b), the ring, passes only because (a) stands behind it** *(checked)*. A ring of 64 frames covered ‹ring64› of takeovers, and 16 frames ‹ring16›. But a new merger always needs pictures. With the picture installed alone behind the ring (b0), ‹b0_g4›, ‹b0_g16›, ‹b0_el› and ‹b0_st› of 1,000 seeds failed.
5. **Fix (c), "a part for the moving slot", also holds** *(checked)*: 0 of 1,000 in every world. A fence never waits for its open, so groups waited at a move ‹c_wait› times less than with (a), and were held by a down group ‹c_held› times less *(counted, in these worlds' sim steps)*. It costs about 2 rules more than (a). A move part costs ‹mp_ms› ms and ‹mp_kb› per move *(measured)*. Every copy of the source group must keep a fenced move's rows until the merger closes the move.
6. **A pair whose partner is down must wait** *(checked)*. Giving it up after 30 steps failed ‹gu_a_g4› and ‹gu_a_st› of 1,000 seeds with (a), and ‹gu_c_g4› and ‹gu_c_st› with (c) (g4, stress). Dropping the waiting half failed ‹gus_g4› and ‹gus_st›. While it waits, the client sees both parts frozen at one exact cut, and health names the down group and the groups it holds. The wait ends when any copy of the down group hosts its partial again: a takeover under rule 4. So MERGE's listed rule "give up a pair when its partner is down" must not be built.
7. **A new merger cannot keep serving while a group is down** *(checked)*. ‹a_rebd› of ‹a_reb› rebuilds (fix a) came while a group was down. The new merger has no part for that group, so it served again only once the group came back: after ‹gapd_mean› steps on average (at most ‹gapd_max›), against ‹gapu_mean› steps when every group was up. V5-20 item 2's "keeps serving" holds for the merger that holds the frozen part, not through a rebuild (section 6).
8. **Pick: (a).** It is the fewest rules, and (b) and (c) both need its pieces. It pays two costs at a takeover, which (b) avoids when its ring reaches back *(measured)*:
   - the group's part stays frozen while the new host builds its partial and picture: ‹pic_range›;
   - the merger's install blocks every group: ‹inst_group› with groups kept apart, flat in the number of groups; O1's one-entry form grows with it (‹inst_one›).
   (b) costs the partial's work on every copy (section 4), and still needs (a) at every rebuild. (c) is the fallback if the move's wait proves too long, judged on the timed move window (V5-20 item 12).
9. **Rules** *(reasoned)*: (a) +3 to +4, (b) +4 to +5, (c) +5 to +6 net, plus health in each. MERGE's net becomes about +10 to +16, not +9 to +14 (section 7).

## 1. What was built

Everything is plain JavaScript on Node 22, in one process: no network, no Raft, no `data`. Queues stand for links.

**Reused from E-64 O1.** [src/partial.mjs](src/partial.mjs) is O1's partial, unchanged. [src/lib.mjs](src/lib.mjs) is O1's helpers, with one import path changed. [src/merger.mjs](src/merger.mjs) is O1's merger with one change: each group's window and filter rows are kept apart, keyed (group, key), as O1 already kept sums, max and distinct per group. O1's one-entry form stays as a switch (the planted bug `keyowner`). A move part, in (c), is one more part of the merger.

**The intake** ([src/intake.mjs](src/intake.mjs)) is new. It holds, per group, the merger's place, the inbound buffer, a pending picture, and whether the group is down. It takes one unit at a time as a join. The join plans a target place per group: it follows each half to the partner it needs, and each half met on the way to its own partner, until nothing more is needed or something is missing. Then it applies the whole plan, pictures first, in a seeded random order of groups.

**The forms.**
- **none** — O1's three rules. Rule 1: frames in order; a picture at or past the merger's place. Rule 2: a half is taken with its partner, with the closure. Rule 3: a picture replaces the group's whole part. A picture carries nothing, so a picture past a half goes in alone.
- **(a) a picture carries its moves** — the picture names every half between the merger's place and its own. The merger installs it with each half's partner, at one cut. At a rebuild, each picture names the halves after the old merger's place.
- **(b) a ring of frames** — every copy keeps its last 64 frames. A new host whose ring reaches back to the merger's place sends those frames again, and no picture is needed. Otherwise, and at every rebuild, (a).
- **(b0)** — the ring, with the picture installed alone behind it.
- **(c) a part for the moving slot** — at A's fence the slot's rows go into a part of their own. B's open or A's unfence takes them out. A fence never waits. An open waits for its fence. A picture names its halves and, with their rows, every move its group fenced that the merger has not closed. So a takeover or a new merger gets the move part back.

**The world** ([sim/sim.mjs](sim/sim.mjs)). One resource of 1,024 slots and 300 keys in E-23's dirty domain. One commit a step; 5 % touch several rows of one group. 600 steps a seed, then a drain.
- **A slot move** (1, 8 or 64 slots, A to B) takes its three steps: planned for 0 to 3 steps (10 % are cancelled there, leaving no trace); A's fence; a carry of 1 to 8 steps, while writes to the slots wait; then B's open, or, for 15 % of moves, B gives up and A unfences.
- **A takeover** (a failover, or the end of an outage): the new host is at or past the merger's place, half the time at its group's head. Its picture is ready 1 to 3 steps later. Frames reach the merger 0 to 3 a step.
- **An outage**: nothing arrives from the group, and nothing is taken from it, for 20 to 120 steps (stress 20 to 140). It ends with a takeover.
- **A rebuild**: a new merger. A group that is down stays down; its picture comes when its outage ends.
- **The merger** takes 0 to 2 units a step from random groups, and drains any buffer past 40.
- **Worlds.** g4 and g16: 4 and 16 fixed groups. Elastic: 1 to 16 groups, made by a grow (half a group's slots to a new group) and removed after a shrink (all its slots out). Stress: 8 groups, with many more moves and faults. Per step: a move starts with chance 1/50, a takeover 1/100, an outage 1/400, a rebuild 1/650; in stress 1/9, 1/28, 1/200 and 1/100.

**The oracle**, written apart from the intake. For each group it keeps that group's rows at the merger's place, replayed from the group's own log. It also keeps the rows of every move fenced at the cut and not closed there: those rows exist, being carried. The truth at the cut is their union. A key held by two of them means the cut is not a cut ("twice").
- After every join the merger serves, its six answers are checked against queries run from scratch on the truth, for the touched keys and buckets. Full checks come every 25 joins, after every picture, and at the end.
- A place never goes back.
- Health (a, b, c): each group the merger names held must be held by exactly the down groups the oracle finds. The oracle finds them from the world's own move table, not from the intake's lists.
- At the end, every outage ends and every move finishes. Every buffer must then drain ("stuck" if it cannot).

**Planted bugs**, 20 of them, each on the same 1,000 seeds in g4 and stress (table 3; section 3 says what each shows).

**The bench** ([bench/bench.mjs](bench/bench.mjs)): a picture takeover at the new host; the merger's install with G groups held; the partial on every copy and a resend from the ring; a move part. Rows are like the sim's, at 1e4 to 1e6 rows. Three runs, each alone under the timing lock.

## 2. Results

1,000 seeds of 600 steps a line, 62 lines. Full tables: [results/summary.md](results/summary.md).

**Table 1. The forms** (seeds failed of 1,000) *(checked)*

| Form | g4 | g16 | elastic | stress | First failures |
|---|---|---|---|---|---|
| none (O1's three rules) | ‹none_g4› | ‹none_g16› | ‹none_el› | ‹none_st› | ‹none_kinds› |
| (a) a picture carries its moves | 0 | 0 | 0 | 0 | — |
| (b) the ring (64 frames), (a) behind it | 0 | 0 | 0 | 0 | — |
| (b0) the ring, a picture alone behind it | ‹b0_g4› | ‹b0_g16› | ‹b0_el› | ‹b0_st› | ‹b0_kinds› |
| (c) a part for the moving slot | 0 | 0 | 0 | 0 | — |
| (b) at 16 and 256 frames (stress) | | | | ‹b16› and ‹b256› | — |

Seeds with rule 4's case: ‹case_line› of 1,000 (fix a: g4, g16, elastic, stress). Under O1's rules, seeds failed with no picture past any half: ‹none_nocase› *(checked)*.

**Table 2. What the worlds threw at fix (a)** (per 1,000 seeds) *(counted)*

‹table2›

**Table 3. Planted bugs** (seeds failed of 1,000) *(checked)*. The last numbers are failures in seeds with no picture past any half: a bug that fails there is not only about rule 4.

‹table3›

**Table 4. Waits** (group-steps over 1,000 seeds, while the merger serves) *(counted)*

‹table4›

**Table 5. Timings** *(measured)*

‹table5›

## 3. Why each piece is needed

- **The closure** (`noclosure`). A fence at A needs B's open, and B's open may sit behind a fence of B's own, whose open sits at C. Each half met on the way brings its own partner. O1's `takeFrom` followed one pair to the queue that must move first; with real moves a chain forms. Without it, ‹ncl_a_g4› (g4) and ‹ncl_a_st› (stress) seeds failed, ‹ncl_a_nc› of them with no picture past any half. So the closure is rule 2's, not rule 4's (S2).
- **Keys kept apart** (`keyowner`). O1 kept one entry per key for the window and the filter, and ignored a drop from a group that did not own the key. A join applies several groups' frames and pictures at one cut, in some order: A's write puts key k over B's entry, then A's fence drops k, and k is gone though B holds it. Without it, ‹ko_a_g4› and ‹ko_a_st› seeds failed (‹ko_a_nc› with no picture past any half). The first run's review found that applying frames before pictures does not save the one-entry form: two pictures can each hold what the other's frames drop (not rerun here).
- **The picture carries its halves** (fix none, `rebuildnol`). Without it the rows of a passed fence vanish, or a passed open counts its rows twice. At a rebuild too: `rebuildnol` failed ‹rnl_g4› and ‹rnl_st›.
- **The join** (`nojoin`). A picture can pass several halves (‹multi› pictures with two or more, fix a, all worlds). Each needs its partner at the same cut.
- **The resume rule** (`ringgap`, ring of 16): a ring that does not reach back to the merger's place must not resume; ‹rg_g4› and ‹rg_st› failed.
- **(c)'s pieces**: the move part (`nomovepart`, ‹nmp_g4› and ‹nmp_st›), the open's wait for its fence (`noorder`, ‹nor_g4› and ‹nor_st›), the picture's rows (`nomoverows`, ‹nmr_g4› and ‹nmr_st›), copies keeping the rows until the merger closes the move (`droprows`, ‹dr_g4› and ‹dr_st›), a new merger getting its move parts back (`rebuildnomove`, ‹rnm_g4› and ‹rnm_st›), its closure and join (`noclosure` ‹ncl_c_g4› and ‹ncl_c_st›; `nojoin` ‹nj_c_g4› and ‹nj_c_st›), and keys apart (`keyowner` ‹ko_c_g4› and ‹ko_c_st›).
- **O1's three rules**, rerun here: `nopair` ‹np_g4› and ‹np_st›, `resyncadd` ‹ra_g4› and ‹ra_st›, `back` ‹bk_g4› and ‹bk_st›.

## 4. The pick: (a) over (b), with (c) as the fallback

**(b) never removes (a).** Every rebuild needs pictures, and so does any takeover the ring cannot reach back over: a long outage outruns any ring. In the worlds here, a ring of 64 frames covered ‹ring64› of takeovers and 16 frames ‹ring16› *(checked)*. With (a) behind it, (b) is (a) plus one rule.

**What (a) pays at a takeover, and (b) avoids when its ring reaches back** *(measured)*:
- **The frozen part.** The group's part stays at its last place while the new host builds its partial over its rows and takes the picture: ‹pic_rows›. In the sim, groups spent ‹picwait_a› group-steps frozen this way with (a), ‹picwait_b› with (b) (all worlds) *(counted)*.
- **The install blocks every group.** The merger runs one install at a time and takes nothing from any group meanwhile. With groups kept apart it removes only that group's entries: ‹inst_rows›, the same at 1, 4 and 16 groups. In O1's one-entry form it scans every group's entries, so it grows with the number of groups: ‹inst_one_rows›. Keeping groups apart, needed for correctness (section 3), also makes the install flat in the number of groups.
- A resend from the ring costs ‹resend› for 16 to 256 frames.

**What (b) costs.** Every copy runs the partial for every record, to keep its ring warm. At 50,000 writes a second per leader (PERF-09), two more copies per group *(arithmetic on measured)*:
- sums: ‹ring_sums› of CPU a second; encoded as bytes, as a ring that sends them would keep them, ‹ring_sums_enc›;
- a top 10: ‹ring_top›. **This rests on the prototype partial** (S4): ‹top_us› µs a record, with an index step and two Maps rebuilt every commit. A partial near the cost of one fold (0.63 to 1.5 µs, E-57 A1 and E-05) would cost 63 to 150 ms a second for the two copies *(reasoned)*.
- O1's six-view partial is much worse: its max and distinct rescan the touched bucket, ‹six_us› µs a record at about 2,000 rows a bucket *(measured)*. MERGE 3.2 left that untimed. A partial needs an ordered index per bucket for max and distinct, as `data`'s views keep.

**So the pick stands: (a).** A takeover is rare, and its two costs are bounded by the group's size. (b)'s cost is paid on every record, on every copy. A warm partial on one standby copy, without a ring, would cut the frozen part; it is not built here *(reasoned)*.

**(c) as the fallback for the move's wait** (V5-20 item 12). (c) drops rule 2's pairing: a fence goes in alone, as a move part. Groups waited at a move ‹c_wait› times less, and were held by a down group ‹c_held› times less *(counted)*. These are sim steps with a carry of 1 to 8 steps (S6). The real wait is the fence-to-open window, aimed at 10 ms (V5-18 pick 4) and not yet timed. Judge (c) on that timing. Beside keys by blocks of slots, (c) needs no slot placement in blocks and never tears a commit. It costs about 2 rules more than (a), and every copy of the source keeps a fenced move's rows until the merger closes the move (‹mp_kb› per move here) *(measured, reasoned)*.

## 5. A pair whose partner is down

MERGE 3.2 listed "giving up a pair when its partner is down" as a missing rule. It must not exist.
- **Giving up is wrong** *(checked)*. Take the waiting unit alone after 30 steps (`giveup`): ‹gu_a_g4› and ‹gu_a_st› seeds failed with (a), ‹gu_c_g4› and ‹gu_c_st› with (c). Drop the waiting half instead (`giveupskip`): ‹gus_g4› and ‹gus_st›. Either way rows vanish or count twice, or the merger can never take the other half later ("stuck").
- **What the client sees** *(checked)*. Both parts frozen at their last places. That is still one exact cut: the answer checks pass at every join while groups are held. Groups were held ‹held_a› group-steps with (a) over the four worlds, ‹held_c› with (c) *(counted)*.
- **Health** *(checked)*. It names the down group, and each group it holds, by the down groups that hold it: ‹hc› checks against the oracle with (a), 0 wrong. Naming only the down group (`health`) failed ‹hl_g4› and ‹hl_st›.
- **When the wait ends.** When any copy of the down group hosts its partial again. That is a takeover, so rule 4 covers it: the new host's picture carries the halves it passed.
- A fresh read waits, as V5-20 item 2 says *(reasoned; reads were not run here)*.

## 6. A new merger while a group is down (S1)

The first run's rebuild brought every down host back. This one keeps outages through a rebuild.
- **The gap** *(counted, fix a)*. ‹gap_table›
- **Why.** The frozen part lived in the old merger's memory. A new merger can get a group's part only from a copy of that group. If none can be reached, it has nothing to serve for that group, and serving the other groups alone would show missing rows *(reasoned)*.
- **What the client sees** *(reasoned)*. Its view stays at the old merger's last frame: one exact cut, frozen for every group, not only the down one. A client that subscribes during the gap gets nothing until the group is back, and health should say why.
- **V5-20 item 2 therefore holds only while the merger that holds the frozen part lives.** Ways to close the gap, none built: keep each merger's parts on a second server (a standby merger fed the same frames); let a client keep its last frame and treat a rebuild as a pause; or accept the gap and state it. This is an owner question (section 11).

## 7. Rule counts

Counted as MERGE counts them *(reasoned)*. Each piece has a planted bug that fails (section 3) *(checked)*.

| Piece | Why | (a) | (b) | (c) |
|---|---|---|---|---|
| Rule 2's closure | a pair's partner can sit behind other halves | +0 to +1 (O1 had a weaker form) | same | same (an open brings its fence) |
| Keys kept apart per group | a join applies several groups at one cut | +1 | +1 | +1 |
| A picture carries its halves | rule 4's case; at a rebuild too | +1 | +1 | +1 (with rows; every copy keeps them until the move closes) |
| The join for a picture with several halves | | +1 | +1 | +1 |
| The resume rule | the ring must reach back | | +1 | |
| The move part | a fence goes in alone | | | +1 |
| An open waits for its fence | | | | +1 |
| A new merger gets its move parts back | | | | +1 |
| Rule 2's pairing | | kept | kept | −1 |
| **Total** | | **+3 to +4** | **+4 to +5** | **+5 to +6** |
| Health names held groups | already in MERGE's list | +1 | +1 | +1 |

Of each total, rule 4 itself is +2 in (a), +3 in (b), +4 in (c) less the pairing; the rest (closure and keys apart, +1 to +2) is rule 2's real form, owed in every form.

**MERGE's net** *(reasoned)*. MERGE 3.2 counts about +9 to +14 net, with rule 4 as one rule and "giving up a pair when its partner is down" as another. Now rule 4 is +2 (one more), rule 2's real form adds +1 to +2, and the give-up rule goes (one less). So about **+10 to +16**.

## 8. What should change in MERGE.md and LAYERS

Proposed only. Those pages are tracked and were not edited here.

**MERGE.md**
- **0, item 6** and **2, rule 4**: replace "not yet run on seeds" with the form that passed: a picture names every half between the merger's place and its own, and the merger installs it with each half's partner, at one cut (E-67: 0 of 4,000 seeds failed).
- **2, rule 2**: add its real form: the closure (each half met on the way to a partner brings its own), and each group's window and filter rows kept apart. Strike "E-23 also had 'each key from exactly one group' ... it never fires": with joins across groups, one entry per key fails; keys are kept apart instead.
- **3.2, Rules**: strike "giving up a pair when its partner is down" (it is wrong); rule 4 counts +2 and rule 2's real form +1 to +2; the net becomes about +10 to +16.
- **3.2, What a client sees**: a group whose next half needs a down group is held too, frozen at one exact cut; health names both. And through a merger rebuild, a group that is down stops the whole view until it is back (section 6).
- **3.7, the ring**: it fixes rule 4's case only with (a) behind it, and never at a rebuild; its cost per copy (section 4).
- **3.2, Cost**: the partial's max and distinct, as built, rescan a bucket: ‹six_us› µs a record at about 2,000 rows a bucket.
- **5.3 item 4** and **5.4 item 7**: as above. **4, combination D** and **question 7**: name (c) beside blocks of slots as the fallback for the move's wait.
- **6 item 1**: done by E-67. Owed from it: the merger on real sockets (6 item 5), `data`'s views as the partials, the move's window timed (6 item 6), and the rebuild gap (section 6).

**LAYERS.md**
- **The row "A resource larger than one server's memory"** (section 10's list): "E-23's merger and its four rules" becomes the merger with rule 4 in form (a), checked on seeds (E-67).
- **8.6 item 7**: a served view merged across groups sees a slot move as two halves taken at one cut; a partial's takeover carries the halves it passed.
- **4.6, owed**: the seeded merger on real sockets; the rebuild gap while a group is down; a partial whose max and distinct keep an index.
- **4.3**: the merger's rules (+3 to +4, plus health) join the count where MERGE's rules are counted.

## 9. How the numbers compare with the first run

The first run's files were lost, so its world's exact rates are not known. This run rebuilt the world from the first run's design; the safety results reproduce, and the rates differ.

| Claim | First run | This run |
|---|---|---|
| O1's three rules: seeds failed (g4, g16, elastic, stress) | 633, 416, 773, 1,000 | ‹none_g4›, ‹none_g16›, ‹none_el›, ‹none_st› |
| (a): seeds failed | 0 in every world | 0 in every world |
| (a): checks; moves; takeovers; outages; rebuilds; case pictures | 1,943,876; 103,479; 39,296; 8,383; 8,785; 31,032 | ‹cmp_a› |
| Closure off (g4, stress) | 195, 997 | ‹ncl_a_g4›, ‹ncl_a_st› |
| One entry per key (stress, a) | 146 | ‹ko_a_st› |
| (b0) (g4, g16, elastic, stress) | 135, 165, 306, 999 | ‹b0_g4›, ‹b0_g16›, ‹b0_el›, ‹b0_st› |
| Ring covered: 64 frames; 16 frames | 97.4 to 100 %; 78.5 % | ‹ring64›; ‹ring16› |
| (c): seeds failed | 0 in every world | 0 in every world |
| (c) against (a): waits at a move; held | 3 to 7 times less; 1.8 to 2.5 times less | ‹c_wait_range› times less; ‹c_held_range› times less |
| Give up after 30 steps: (a) g4, stress; (c) g4, stress | 249, 709; 162, 524 | ‹gu_a_g4›, ‹gu_a_st›; ‹gu_c_g4›, ‹gu_c_st› |
| A picture takeover | 36 ms to 6.2 s | ‹pic_range› |
| A resend from the ring | 10 µs to 7.7 ms | ‹resend› |
| A move part | 0.2 to 33 ms; 3 to 943 KB | ‹mp_ms› ms; ‹mp_kb› |
| The install, one group, 1e6 rows | 1.26 to 1.46 s | ‹inst_1e6› |
| Ring CPU, two more copies at 50,000 writes a second: sums; top 10 | 44 to 45 ms; 0.55 to 0.66 s | ‹ring_sums›; ‹ring_top› |
| Rules: (a); (b); (c) | +3 (3 to 4); +4 (4 to 5); +5 (5 to 6) | +3 to +4; +4 to +5; +5 to +6 |

Where they differ, and why *(reasoned)*:
- **Fewer seeds fail under O1's rules here**, most in g16. Here a takeover lands on one of the groups, picked from all of them, so with 16 groups each group's partial fails less often, and fewer pictures pass a waiting half. Also about a third of moves are of one slot, and with 300 keys over 1,024 slots most of those carry no rows; a passed half with no rows changes no answer.
- **(b0) fails less** in the three mild worlds. Here a new merger takes each picture as it comes and keeps taking the frames of the groups it has. A half that a lone picture passed is often taken alone before the last picture arrives, which repairs the cut before the merger serves. In stress it still fails in most seeds.
- **The ring covers more at 16 frames** here: stress has 8 groups, so an outage of up to 140 steps is about 17 commits a group.
- **The takeover's picture at 1e6 rows is slower** (about 8 s), and the install with one group faster. The first run's exact shapes for these were not kept.
- **The prototype top 10 costs more a record** here (‹top_us› µs), so the ring's top-10 figure is higher.
- **The first run's `keyowner` and `rebuildnol`** failed mostly in stress too.

## 10. Limits, and what the review changed

**Limits.**
- **The three-commit move** (S6). V5-18 pick 4 cut the move to one commit (E-17b's fused form: A's fence is the decision, and B's one entry is the final copy, which opens the slot). This study runs the three-commit form. The merger sees the same halves in both: A's fence, then B's open, or B's give-up and A's unfence. So the safety results carry over *(reasoned)*. The waits are sim steps with a carry of 1 to 8 steps; with the fused move the fence-to-open window is a few milliseconds, so the waits (a) pays may be much smaller in real time, and (c)'s gain with them.
- **One process.** Queues stand for links; no Raft; no `data`. The partials are O1's plain code, not `data` 5's views.
- **The world's rates are this study's own** (section 9). g4 and g16 share their fault draws: the same steps bring a takeover, an outage or a rebuild, though the group it hits differs (N2).
- **"No failing seed without the case"** is tested on few seeds in stress: ‹st_nocase_seeds› of 1,000 had no picture past any half there (N2).
- **Full checks** come every 25 joins and after every picture; between them only touched keys and buckets are checked, so a wrong value elsewhere could heal unseen for up to 24 joins (N3).
- **The health oracle** reads the world's move table and the merger's places, not the intake's lists, but follows the same definition of "held". A shared misreading would hide in both. The planted bugs that change the join (`nopair`, `noclosure`, `nojoin`, `noorder`) run without the health check, so they fail on answers (N4).
- **Giving up** was run in two forms: take the unit alone, and drop the waiting half. Removing the down group's whole part was not run; its rows would vanish (N6).
- **The bench** keeps frames as JSON strings when it times a ring of bytes (N7). Rows are small (three fields). The install was timed with a picture that changed 1 % of the group's rows.
- **Reads** (`{ pages }`, a fresh read that waits) were not run.

**What the review changed** (the first run's review, folded in here):
- **S1**: outages stay through a rebuild; the gap is reported (section 6).
- **S2**: the closure is split: rule 2's part and rule 4's join, each with its own planted bug and its failures in seeds without the case (sections 3 and 7).
- **S3**: the pick names (a)'s two takeover costs, and the install is timed at 1, 4 and 16 groups (section 4).
- **S4**: the ring's top-10 figure is marked as the prototype's and scaled to a fold's cost (section 4).
- **S5**: every copy of the source group keeps a fenced move's rows until the merger closes the move; a planted bug (`droprows`) checks it.
- **S6**: the three-commit form and the sim-step waits are stated (above, and section 4).
- **N1**: groups removed are counted when removed (‹removed› in elastic, fix a), not when a shrink starts.
- **N2, N3, N4, N7**: stated above. **N5**: the queue is called the merger's inbound buffer, dropped at a takeover. **N6**: `giveupskip` added.

## 11. Questions for the owner

1. **A new merger while a group is down.** V5-20 item 2 keeps a merged view serving with a down group frozen, but a merger rebuilt during that outage has no part for the group. Pick: state the gap (the view stays at its last frame until the group is back) and study a standby merger later. Other way: a standby merger fed the same frames, in the first build.
2. **(c) as the fallback for the move's wait**, beside or before keys by blocks of slots (V5-20 item 12)? Pick: yes, judged on the timed move window.
3. **The MERGE.md and LAYERS edits** in section 8: apply them?

## 12. How to run, and the files

```
./run.sh quick    # a smoke run: a few lines of 20 seeds and one bench part, nothing written
./run.sh sim      # the 62 lines of 1,000 seeds (results/sim.jsonl)
./run.sh bench    # the timings, three runs (results/bench.jsonl)
./run.sh S        # the tables (results/summary.md)
./run.sh full     # sim, bench, S
```

`SP` names a folder holding `bin/heavy` and `bin/timing` lock wrappers, if there are any; `PAR` (default 3) lines run at once; `SEEDS` (default 1000). One seed with its counters: `node sim/sim.mjs --world=stress --fix=a --seed=7 --seeds=1 --trace`. Each process stays under 3.5 GB.

- [src/lib.mjs](src/lib.mjs), [src/partial.mjs](src/partial.mjs): from E-64 O1 (one import path changed in lib.mjs).
- [src/merger.mjs](src/merger.mjs): O1's merger, with groups kept apart and a whole-part drop.
- [src/intake.mjs](src/intake.mjs): the merger's rules in each form; the planted bugs on its side.
- [sim/sim.mjs](sim/sim.mjs): the world, the oracle, the planted bugs on the world's side.
- [bench/bench.mjs](bench/bench.mjs), [bench/summarize.mjs](bench/summarize.mjs).
- [results/sim.jsonl](results/sim.jsonl), [results/bench.jsonl](results/bench.jsonl), [results/summary.md](results/summary.md).

Sources: [MERGE.md](../../MERGE.md) sections 3.2, 3.7, 5 and 6; [DECISIONS](../../../DECISIONS.md) V5-18 and V5-20; [E-64 O1](../E64-past-one-process/O1/README.md) and its [probe](../E64-past-one-process/probes/move-failover.mjs); [LAYERS.md](../../LAYERS.md) 8.6.
