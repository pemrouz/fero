# E-67: the merger's rule 4 on seeds

2026-11-23. V5-20 item 1 ([DECISIONS](../../../DECISIONS.md)) ships the merger ([MERGE.md](../../MERGE.md)'s O1) in the first build once its rule 4 passes seeded runs. Rule 4 is about a partial's host that fails while a slot move waits. MERGE section 6 item 1 asks for that run: real three-step moves, a new host that starts at its own place, a move that gives up, a partial down while a move to its group waits, and a pick between "a picture carries its moves" and "a ring of frames on every copy" (MERGE 3.7). V5-20 item 2 (a group that cannot be reached keeps serving, frozen) and item 12 (the merger waits at a move; keys by blocks of slots are the fallback) bear on the same run.

**This is a rebuild.** A first run built this study and a skeptic reviewed it. Its files were lost before the review's fixes went in. This run rebuilt the study to the same design and took in every review finding from the start. A second skeptic then reviewed the rebuild; its findings are in too, with a rerun of every seeded line. Section 10 lists what both reviews changed. Every number here comes from this run. Section 9 compares them with the first run's.

**Marks.** *(measured)*: timed, three runs, each run alone on the box under a timing lock, a range. *(checked)*: a seeded run with an oracle, here, in [results/](results/summary.md). *(counted)*: a count from a run. *(reasoned)*: an argument; nothing ran it.

## Words

- **Group, slot, partial, merger, cut, frame, picture**: as in MERGE.md section 1. A **copy** is one server's replica of a group's log. Every copy folds the same log, so every copy could make the same partial frames.
- **Host.** The copy that runs a group's partial and sends its frames to the merger.
- **Half.** A slot move's frame at one group: A's **fence** (the slot's rows leave A), B's **open** (they arrive at B), or A's **unfence** (B gave up, and the rows come back to A).
- **Takeover.** Another copy becomes the host, at its own place. The merger drops its **inbound buffer** from the old host (the frames that arrived and were not taken yet). The new host sends a **picture** at its place, then its frames.
- **Rule 4's case.** A picture that passed a half whose partner the picture does not hold. **With rows**: the move carried rows. Only those can change an answer, but a passed half with no rows must be carried too, or the merger wedges (section 3). In O1's own run neither happened (MERGE 3.2).
- **Join.** The merger takes one group's next frame or picture together with everything it needs, at one cut. Nothing is shown in between.
- **Held.** A group whose next half needs a half from a group that is down (its partial unreachable).
- **Rebuild.** A new merger, with no part. Every group's host sends a picture.
- **Floor.** The place a picture's halves start from. At a takeover it is the live merger's place. At a rebuild it is one cut of the old merger, which the hosts keep from its acks (section 6.1).
- **Stuck.** The merger wedged: a unit it can never take. A seed fails "stuck" when the merger cannot drain at the end. Every other failure is a failure **on answers**.

## 0. The answer first

1. **The bug is real** once moves take their three real steps *(checked)*. Under O1's three rules, 366, 114, 321 and 923 of 1,000 seeds failed (g4, g16, elastic, stress); 352, 90, 315 and 918 of them on answers, the rest stuck. Every failing seed had a picture that passed a half; no seed without one failed.
   - In 40 failing seeds every passed half had no rows. 39 of them failed stuck, and one held a key twice *(checked)*. A half with no rows changes no answer, but if the picture does not carry it, its partner waits for ever and the merger wedges. So rule 4 must carry halves with no rows too.
2. **Fix (a), "a picture carries its moves", holds** *(checked)*: 0 of 1,000 seeds failed in each of the four worlds. That is 2,066,979 checks through 93,389 moves, 46,257 takeovers, 7,395 outages, 9,061 merger rebuilds (2,313 of them while a group was down) and 11,765 pictures with rule 4's case with rows.
3. **A new merger must start every picture from one cut of the old merger** *(checked)*. The dead merger cannot hand over its places. The rule: each ack carries the merger's whole cut, each group's copies keep the last one acked to them, and the new merger takes the oldest of the up groups' cuts and tells every host before the pictures.
   - With it, (a), (b) and (c) failed 0 of 1,000 in each world. For (a) that is 9,061 rebuilds whose 67,661 lowered pictures named 88,184 more halves.
   - With each group starting from its own kept place (`mixedfloor`), (a) failed 107 and 732 of 1,000 (g4, stress), all stuck: a fence names an open below its partner's floor, which nothing will ever name. (c) failed 76 and 878 on answers: a part for a move already closed counts its rows twice.
   - The rule has two clauses. A removed group is past every half it held: without that, 42 (a) and 45 (c) of 1,000 elastic seeds wedged (`gonewait`). And in (c) the same cut says which moves are closed, so a copy keeps a fenced move's rows until the move is closed at every cut a new merger could start from.
4. **Rule 4 is two rules, and rule 2 needs two more once moves are real** *(checked)*.
   - Rule 4 itself: the picture names the halves it passed, and the merger joins it with each half's partner at one cut. With a picture's halves joined one at a time (`nojoin`), 97 and 727 of 1,000 seeds failed (g4, stress), 72 and 379 of them on answers. All were seeds where a picture passed a half (in 3, only halves without rows).
   - Rule 2, the pairing: a half's partner can sit behind other halves, which bring their own partners (the **closure**); and each group's window and filter rows must be kept apart. Both failed in seeds that never had rule 4's case. So they belong to rule 2, and O1 had them only in part (section 7).
5. **Fix (b), the ring, passes only because (a) stands behind it** *(checked)*. A ring of 64 frames covered 96.3 to 100.0 % of takeovers; 16 frames covered 84.8 % (elastic) and 98.6 % (stress), and 256 frames 100.0 % (elastic). But a new merger always needs pictures. With the picture installed alone behind the ring (b0), 59, 16, 83 and 583 of 1,000 seeds failed.
   - Those rates are the sim's: one commit a step across all groups. At 50,000 writes a second per leader, 64 frames hold about 1.3 ms of commits, far less than a failover takes to notice. So in real time a ring would rarely reach back, and (b) would nearly always fall back to (a)'s picture *(reasoned)*.
6. **Fix (c), "a part for the moving slot", also holds** *(checked)*: 0 of 1,000 in every world. A fence never waits for its open, so groups waited at a move 2.3 to 13.0 times less than with (a), and were held by a down group 1.6 to 2.6 times less *(counted, in these worlds' sim steps)*. It costs about 2 rules more than (a). A move part costs 0.4 to 31.2 ms and 1.1 to 830 KB per move *(measured)*. At every fence the slots' rows go to the merger, which holds a part until the move closes; every copy of the source group keeps those rows too (section 4).
7. **A pair whose partner is down must wait** *(checked)*. Giving it up after 30 steps failed 221 and 611 of 1,000 seeds with (a) (178 and 397 on answers), and 81 and 232 with (c) (g4, stress). Dropping the waiting half failed 193 and 574 (179 and 413 on answers). While it waits, the client sees both parts frozen at one exact cut, and health names the down group and the groups it holds. The wait ends when any copy of the down group hosts its partial again: a takeover under rule 4. So MERGE's listed rule "give up a pair when its partner is down" must not be built.
8. **A new merger cannot keep serving while a group is down.** 2,313 of 9,061 rebuilds (fix a) came while a group was down. Such a merger served again only once the group came back: after 60 steps on average (at most 409), against 15.9 steps when every group was up *(counted)*. That gap follows from the sim's own rule that a new merger serves only once it has every part; the reason it cannot serve sooner is that it has no part for the down group *(reasoned)*. V5-20 item 2's "keeps serving" holds for the merger that holds the frozen part, not through a rebuild (section 6.2).
9. **Pick: (a).** It is the fewest rules, and (b) and (c) both need its pieces. It pays two costs at a takeover, which (b) avoids when its ring reaches back *(measured)*:
   - the group's part stays frozen while the new host builds its partial and picture: 27.6 to 30.5 ms at 1e4 rows, 312 to 409 ms at 1e5, 5.92 to 7.84 s at 1e6. Most of this is building O1's six-view prototype partial (5.26 to 7.14 s at 1e6); at one fold's cost a row the build would take about 0.6 to 1.5 s *(reasoned)*;
   - the merger's install blocks every group: with groups kept apart, 0.74 to 1.24 ms at 1e4 rows a group and 7.78 to 14.0 ms at 1e5, about the same at 1, 4 and 16 groups; at 1e6, 174 to 252 ms with 1 group and 215 to 397 ms with 4 (16 not timed). O1's one-entry form grows with the number of groups (at 1e5 rows a group, 20.6 to 23.6 ms with 1 group, 84.3 to 89.2 ms with 4, 254 to 286 ms with 16; at 1e6, 464 to 631 ms with 1 and 1.49 to 1.60 s with 4).
   (b) costs the partial's work on every copy (section 4), and still needs (a) at every rebuild. (c) is the fallback if the move's wait proves too long, judged on the timed move window (V5-20 item 12).
10. **Rules** *(reasoned)*: (a) +4 to +6, (b) +5 to +7, (c) +6 to +8 net, plus health in each. MERGE's net becomes about +11 to +18, not +9 to +14 (section 7).

## 1. What was built

Everything is plain JavaScript on Node 22, in one process: no network, no Raft, no `data`. Queues stand for links.

**Reused from E-64 O1.** [src/partial.mjs](src/partial.mjs) is O1's partial, unchanged. [src/lib.mjs](src/lib.mjs) is O1's helpers, with one import path changed. [src/merger.mjs](src/merger.mjs) is O1's merger with one change: each group's window and filter rows are kept apart, keyed (group, key), as O1 already kept sums, max and distinct per group. O1's one-entry form stays as a switch (the planted bug `keyowner`). A move part, in (c), is one more part of the merger.

**The intake** ([src/intake.mjs](src/intake.mjs)) is new. It holds, per group, the merger's place, the inbound buffer, a pending picture, and whether the group is down. It takes one unit at a time as a join. The join plans a target place per group: it follows each half to the partner it needs, and each half met on the way to its own partner, until nothing more is needed or something is missing. Then it applies the whole plan, pictures first, in a seeded random order of groups. A half whose partner's group was removed needs nothing: the merger removes a group only after it took every half the group held.

**The forms.**
- **none** — O1's three rules. Rule 1: frames in order; a picture at or past the merger's place. Rule 2: a half is taken with its partner, with the closure. Rule 3: a picture replaces the group's whole part. A picture carries nothing, so a picture past a half goes in alone.
- **(a) a picture carries its moves** — the picture names every half between its floor (the merger's place, at a takeover) and its own place, with rows or not. The merger installs it with each half's partner, at one cut. At a rebuild, each picture names the halves after the floor (section 6.1).
- **(b) a ring of frames** — every copy keeps its last 64 frames. A new host whose ring reaches back to the merger's place sends those frames again, and no picture is needed. Otherwise, and at every rebuild, (a).
- **(b0)** — the ring, with the picture installed alone behind it.
- **(c) a part for the moving slot** — at A's fence the slot's rows go into a part of their own. B's open or A's unfence takes them out. A fence never waits. An open waits for its fence. A picture names its halves and, with their rows, every move its group fenced that the merger has not closed (at a rebuild: not closed at the floor cut). So a takeover or a new merger gets the move part back.

**The world** ([sim/sim.mjs](sim/sim.mjs)). One resource of 1,024 slots and 300 keys in E-23's dirty domain. One commit a step; 5 % touch several rows of one group. 600 steps a seed, then a drain.
- **A slot move** (1, 8 or 64 slots, A to B) takes its three steps: planned for 0 to 3 steps (10 % are cancelled there, leaving no trace); A's fence; a carry of 1 to 8 steps, while writes to the slots wait; then B's open, or, for 15 % of moves, B gives up and A unfences.
- **A takeover** (a failover, or the end of an outage): the new host is at or past the merger's place, half the time at its group's head. Its picture is ready 1 to 3 steps later. Frames reach the merger 0 to 3 a step.
- **An outage**: nothing arrives from the group, and nothing is taken from it, for 20 to 120 steps (stress 20 to 140). It ends with a takeover.
- **A rebuild**: a new merger. A group that is down stays down; its picture comes when its outage ends. Its pictures start from a floor, in one of two ways (section 6.1). **Exact**: the dead merger's own last places, and in (c) its own closed moves. A real new merger cannot know these; the main lines run this way. **From acks** (`--floor=acked`): each group's copies keep the last whole cut acked to them (here one of the merger's last 64 served cuts, drawn per group); the new merger takes the oldest of the up groups' cuts; every picture starts from it, and in (c) it says which moves are closed.
- **The merger** takes 0 to 2 units a step from random groups, and drains any buffer past 40.
- **Worlds.** g4 and g16: 4 and 16 fixed groups. Elastic: 1 to 16 groups, made by a grow (half a group's slots to a new group) and removed after a shrink (all its slots out). Stress: 8 groups, with many more moves and faults. Per step: a move starts with chance 1/50, a takeover 1/100, an outage 1/400, a rebuild 1/650; in stress 1/9, 1/28, 1/200 and 1/100.

**The oracle**, written apart from the intake. For each group it keeps that group's rows at the merger's place, replayed from the group's own log. It also keeps the rows of every move fenced at the cut and not closed there: those rows exist, being carried. The truth at the cut is their union. A key held by two of them means the cut is not a cut ("twice").
- After every join the merger serves, its six answers are checked against queries run from scratch on the truth, for the touched keys and buckets. Full checks come every 25 joins, after every picture, and at the end.
- A place never goes back.
- Health (a, b, c): each group the merger names held must be held by exactly the down groups the oracle finds. The oracle finds them from the world's own move table, not from the intake's lists.
- At the end, every outage ends and every move finishes. Every buffer must then drain ("stuck" if it cannot).

**Planted bugs**, 24 of them (table 3; section 3 says what each shows). Each runs on the same 1,000 seeds in g4 and stress, except `gonewait`, which runs in elastic, the one world that removes groups.

**The bench** ([bench/bench.mjs](bench/bench.mjs)): a picture takeover at the new host; the merger's install with G groups held; the partial on every copy and a resend from the ring; a move part. Rows are like the sim's, at 1e4 to 1e6 rows. Three runs, each alone under the timing lock.

## 2. Results

1,000 seeds of 600 steps a line, 81 lines. Full tables: [results/summary.md](results/summary.md).

**Table 1. The forms** (seeds failed of 1,000; in brackets, on answers / stuck) *(checked)*. The main lines start a rebuild's pictures from the dead merger's own places; the last three take the floor from the hosts' acks (section 6.1).

| Form | g4 | g16 | elastic | stress | First failures (stress) |
|---|---|---|---|---|---|
| none (O1's three rules) | 366 (352 / 14) | 114 (90 / 24) | 321 (315 / 6) | 923 (918 / 5) | window 328, twice 243, union 237, add 110 |
| (a) a picture carries its moves | 0 | 0 | 0 | 0 | — |
| (b) the ring (64 frames), (a) behind it | 0 | 0 | 0 | 0 | — |
| (b0) the ring, a picture alone behind it | 59 (56 / 3) | 16 (15 / 1) | 83 (79 / 4) | 583 (569 / 14) | union 185, window 185, twice 121, add 78 |
| (c) a part for the moving slot | 0 | 0 | 0 | 0 | — |
| (b) at 16 frames | | | 0 | 0 | — |
| (b) at 256 frames | | | 0 | | — |
| (a), the rebuild floor from acks | 0 | 0 | 0 | 0 | — |
| (b), the rebuild floor from acks | 0 | 0 | 0 | 0 | — |
| (c), the rebuild floor from acks | 0 | 0 | 0 | 0 | — |

Seeds with rule 4's case, any half / with rows (fix a): 556 / 424, 294 / 190, 431 / 395, 998 / 994 (g4, g16, elastic, stress). Under O1's rules every failing seed had a picture past some half. In 11, 21, 6 and 2 of them every passed half had no rows; all but one of those 40 failed stuck *(checked)*.

**Table 2. What the worlds threw at fix (a)** (per 1,000 seeds) *(counted)*

| World | Moves started (cancelled / opened / gave up) | Slots moved | Takeovers | Outages | Rebuilds (a group down) | Pictures | Case pictures (takeover / rebuild) | Checks |
|---|---|---|---|---|---|---|---|---|
| g4 | 12,227 (1,205 / 9,353 / 1,669) | 228,646 | 7,457 | 1,492 | 971 (148) | 11,182 | 716 (501 / 215) | 552,839 |
| g16 | 11,419 (1,091 / 8,775 / 1,553) | 208,733 | 7,457 | 1,492 | 971 (148) | 22,834 | 283 (121 / 162) | 569,106 |
| elastic | 6,971 (690 / 5,303 / 978) | 1,223,378 | 7,093 | 1,412 | 970 (142) | 9,131 | 678 (538 / 140) | 518,606 |
| stress | 62,772 (6,181 / 48,227 / 8,364) | 1,100,560 | 24,250 | 2,999 | 6,149 (1,875) | 71,183 | 10,088 (2,575 / 7,513) | 426,428 |

Elastic also made 3,022 groups and removed 792 (counted when removed, after 1,030 shrinks started).

**Table 3. Planted bugs** (seeds failed of 1,000; in brackets, on answers / stuck) *(checked)*. "No case": failing seeds where no picture passed any half; a bug that fails there is not only about rule 4. `mixedfloor` and `gonewait` take the floor from acks.

| Form | Planted | What it breaks | g4 | stress | Failed with no case (g4 / stress) | First failures (stress) |
|---|---|---|---|---|---|---|
| a | `nopair` | O1's rule 2: halves one by one | 1,000 | 1,000 | 905 / 704 | window 544, add 241, twice 126 |
| a | `resyncadd` | O1's rule 3: a picture added, the old part not taken out | 1,000 | 1,000 | 899 / 683 | add 1000 |
| a | `back` | O1's rule 1: a picture behind the merger's place | 990 | 1,000 | 921 / 696 | back 1000 |
| a | `noclosure` | rule 2's closure off | 211 (208 / 3) | 916 (899 / 17) | 123 / 180 | window 327, union 226, twice 206 |
| a | `keyowner` | O1's one entry per key | 97 | 478 | 48 / 54 | union 321, window 157 |
| a | `nojoin` | rule 4's join: a picture's halves one at a time | 97 (72 / 25) | 727 (379 / 348) | 0 / 0 | stuck 348, window 136, twice 116 |
| a | `rebuildnol` | a new merger's pictures carry no halves | 51 (46 / 5) | 575 (564 / 11) | 0 / 0 | window 191, union 177, twice 121 |
| a | `mixedfloor` | a new merger: each group starts from its own kept place, not one cut | 107 (0 / 107) | 732 (0 / 732) | 14 / 0 | stuck 732 |
| a | `health` | health names down groups only | 428 | 771 | 350 / 218 | health 771 |
| a | `giveup` | a pair whose partner is down: taken alone after 30 steps | 221 (178 / 43) | 611 (397 / 214) | 110 / 37 | stuck 214, twice 138, window 115 |
| a | `giveupskip` | a pair whose partner is down: the half dropped after 30 steps | 193 (179 / 14) | 574 (413 / 161) | 77 / 24 | twice 177, stuck 161, union 92 |
| b | `ringgap` | resume from a ring (16) that does not reach back | 437 | 220 (212 / 8) | 402 / 50 | union 107, window 68, add 20 |
| c | `nomovepart` | no move part | 995 | 1,000 | 869 / 685 | window 537, add 310, union 153 |
| c | `noorder` | an open does not wait for its fence | 835 | 999 | 613 / 358 | twice 613, window 386 |
| c | `noclosure` | the closure off | 25 | 302 | 14 / 16 | twice 223, window 76, union 3 |
| c | `nojoin` | a picture's halves one at a time | 14 | 153 | 0 / 0 | twice 105, window 46, add 1 |
| c | `nomoverows` | a picture carries no move rows | 184 | 766 | 7 / 7 | union 332, window 242, add 192 |
| c | `droprows` | copies drop the rows at B's open, not at the merger's close | 114 | 569 | 2 / 3 | union 255, window 171, add 143 |
| c | `rebuildnomove` | a new merger loses older move parts | 12 | 122 | 7 / 7 | add 76, window 34, union 12 |
| c | `mixedfloor` | a new merger: each group starts from its own kept place and closed moves | 76 | 878 | 32 / 18 | add 491, window 274, union 113 |
| c | `keyowner` | O1's one entry per key | 118 | 527 | 66 / 49 | union 385, window 142 |
| c | `giveup` | an open whose fence is down: taken alone after 30 steps | 81 | 232 | 44 / 7 | twice 174, window 54, union 3 |
| a | `gonewait` | a removed group not past its halves (run in elastic, the one world that removes groups) | elastic: 42 (0 / 42) | | 8 (elastic) | stuck 42 (elastic) |
| c | `gonewait` | as above, and a part for a move into a removed group installed | elastic: 45 (3 / 42) | | 16 (elastic) | stuck 42, window 2, add 1 (elastic) |

Every planted bug failed in both of its worlds; the weakest failed 122 of 1,000 seeds in its stronger world (`gonewait`, run in elastic alone, 42 and 45). The floor bugs of (a) and `gonewait` fail only as stuck: they break liveness, not answers.

**Table 4. Waits** (group-steps over 1,000 seeds, while the merger serves) *(counted)*

| World | (a) at a move | (c) at a move | (a) / (c) | (a) held | (c) held | (a) / (c) | (a) frozen for a picture | (b) frozen for a picture |
|---|---|---|---|---|---|---|---|---|
| g4 | 54,968 | 13,321 | 4.1 | 28,096 | 12,440 | 2.3 | 13,923 | 6 |
| g16 | 36,137 | 2,772 | 13.0 | 5,914 | 2,561 | 2.3 | 13,604 | 0 |
| elastic | 33,249 | 14,329 | 2.3 | 18,563 | 11,597 | 1.6 | 13,213 | 487 |
| stress | 232,346 | 50,121 | 4.6 | 121,973 | 46,376 | 2.6 | 34,963 | 0 |

**Table 5. Timings** *(measured)*

| What | Size | Time | Note |
|---|---|---|---|
| (a) a picture takeover at the new host: build the partial, take the picture | 10,000 rows | 27.6 to 30.5 ms | picture 0.3 MB as JSON |
| (a) a picture takeover at the new host: build the partial, take the picture | 100,000 rows | 312 to 409 ms | picture 2.7 MB as JSON |
| (a) a picture takeover at the new host: build the partial, take the picture | 1,000,000 rows | 5.92 to 7.84 s | picture 28.2 MB as JSON |
| the merger's install, groups kept apart (1, 4, 16 groups held) | 10,000 rows a group | 0.74 to 1.24 ms | flat in the number of groups |
| the merger's install, O1's one entry per key (1, 4, 16 groups) | 10,000 rows a group | 2.22 to 3.26 ms / 2.87 to 3.41 ms / 12.9 to 13.9 ms | grows with the groups |
| the merger's install, groups kept apart (1, 4, 16 groups held) | 100,000 rows a group | 7.78 to 14.0 ms | flat in the number of groups |
| the merger's install, O1's one entry per key (1, 4, 16 groups) | 100,000 rows a group | 20.6 to 23.6 ms / 84.3 to 89.2 ms / 254 to 286 ms | grows with the groups |
| the merger's install, groups kept apart (1, 4 groups held) | 1,000,000 rows a group | 174 to 252 ms / 215 to 397 ms | 16 groups not timed at this size |
| the merger's install, O1's one entry per key (1, 4, 16 groups) | 1,000,000 rows a group | 464 to 631 ms / 1.49 to 1.60 s | grows with the groups |
| (b) the partial on a copy, per record: sums | 100,000 rows | 0.2 to 0.36 µs (0.8 to 1.14 encoded) | 70 B a frame |
| (b) the partial on a copy, per record: top 10 (prototype) | 100,000 rows | 7.23 to 7.64 µs (7.94 to 8.27 encoded) | 28 B a frame |
| (b) the partial on a copy, per record: O1's six views | 100,000 rows | 514 to 559 µs (449 to 689 encoded) | 182 B a frame |
| (b) the partial on a copy, per record: sums | 1,000,000 rows | 0.65 to 0.84 µs (1.15 to 1.31 encoded) | 70 B a frame |
| (b) the partial on a copy, per record: top 10 (prototype) | 1,000,000 rows | 14.0 to 21.2 µs (14.9 to 19.9 encoded) | 28 B a frame |
| (b) a resend from the ring, decoded and taken | 16 / 64 / 256 frames | 18.5 to 163 / 36.2 to 417 / 62.2 to 1,010 µs | sums and top 10 (the six-view resend applied only two parts of each frame, so it is left out) |
| (c) a move part: made, installed, dropped | 1 slot of 4,096, a resource of 100,000 rows (24 rows) | 0.4 to 0.58 ms | rows 1.1 KB as JSON |
| (c) a move part: made, installed, dropped | 8 slots of 4,096, a resource of 100,000 rows (195 rows) | 0.68 to 0.9 ms | rows 9.6 KB as JSON |
| (c) a move part: made, installed, dropped | 64 slots of 4,096, a resource of 100,000 rows (1,563 rows) | 1.97 to 2.99 ms | rows 80.0 KB as JSON |
| (c) a move part: made, installed, dropped | 1 slot of 4,096, a resource of 1,000,000 rows (244 rows) | 0.56 to 0.78 ms | rows 12.1 KB as JSON |
| (c) a move part: made, installed, dropped | 8 slots of 4,096, a resource of 1,000,000 rows (1,953 rows) | 3.13 to 3.52 ms | rows 100.5 KB as JSON |
| (c) a move part: made, installed, dropped | 64 slots of 4,096, a resource of 1,000,000 rows (15,625 rows) | 29.1 to 31.2 ms | rows 830.5 KB as JSON |

## 3. Why each piece is needed

- **The closure** (`noclosure`). A fence at A needs B's open, and B's open may sit behind a fence of B's own, whose open sits at C. Each half met on the way brings its own partner. O1's `takeFrom` followed one pair to the queue that must move first; with real moves a chain forms. Without it, 211 (g4) and 916 (stress) seeds failed, 303 of them with no picture past any half. So the closure is rule 2's, not rule 4's (S2).
- **Keys kept apart** (`keyowner`). O1 kept one entry per key for the window and the filter, and ignored a drop from a group that did not own the key. A join applies several groups' frames and pictures at one cut, in some order: A's write puts key k over B's entry, then A's fence drops k, and k is gone though B holds it. Without it, 97 and 478 seeds failed (102 with no picture past any half). The first run's review found that applying frames before pictures does not save the one-entry form: two pictures can each hold what the other's frames drop (not rerun here).
- **The picture carries its halves** (fix none, `rebuildnol`). Without it the rows of a passed fence vanish, or a passed open counts its rows twice. At a rebuild too: `rebuildnol` failed 51 and 575.
- **Halves with no rows count too** (F1). A passed half whose move carried no rows changes no answer. But if the picture does not name it, its partner later waits for a half the merger will never see. Under O1's rules 40 failing seeds had only such halves, and 39 of them failed stuck *(checked)*.
- **The join** (`nojoin`). A picture can pass several halves (2,504 pictures with two or more, fix a, all worlds). Each needs its partner at the same cut. Without it, 97 and 727 failed, 72 and 379 on answers.
- **One floor at a rebuild** (`mixedfloor`, `gonewait`; section 6.1). Each group starting from its own kept place failed 107 and 732 with (a), all stuck, and 76 and 878 with (c), on answers. Waiting for a removed group failed 42 (a) and 45 (c) in elastic, nearly all stuck.
- **Why so many planted bugs fail "stuck"** (F1). In `nojoin`, `giveup` and `giveupskip`, 25 to 348 of the failing seeds wedged. Once a half's partner was taken out of turn, a fence looks for its open among the frames not yet taken (`closeOf` in the intake), not among the closed moves, so it waits for ever. With rows, a seed often fails on answers first; at a rebuild the merger does not serve, so nothing is checked before the wedge *(reasoned from the code)*. So part of each count measures how this intake wedges. On answers alone each still fails clearly: `nojoin` 72 and 379, `giveup` 178 and 397, `giveupskip` 179 and 413.
- **The resume rule** (`ringgap`, ring of 16): a ring that does not reach back to the merger's place must not resume; 437 and 220 failed.
- **(c)'s pieces**: the move part (`nomovepart`, 995 and 1,000), the open's wait for its fence (`noorder`, 835 and 999), the picture's rows (`nomoverows`, 184 and 766), copies keeping the rows until the merger closes the move (`droprows`, 114 and 569), a new merger getting its move parts back (`rebuildnomove`, 12 and 122), its closure and join (`noclosure` 25 and 302; `nojoin` 14 and 153), and keys apart (`keyowner` 118 and 527).
- **O1's three rules**, rerun here: `nopair` 1,000 and 1,000, `resyncadd` 1,000 and 1,000, `back` 990 and 1,000.

## 4. The pick: (a) over (b), with (c) as the fallback

**(b) never removes (a).** Every rebuild needs pictures, and so does any takeover the ring cannot reach back over: a long outage outruns any ring. In the worlds here, a ring of 64 frames covered 96.3 to 100.0 % of takeovers. In elastic, where 64 frames missed 254, 16 frames covered 84.8 % and 256 frames 100.0 % (1 missed) *(checked)*. With (a) behind it, (b) is (a) plus one rule.
- **That coverage is the sim's rate, not a real one** (F3). The sim makes one commit a step across all groups; a 140-step outage in stress is about 17 commits a group. At 50,000 writes a second per leader, 64 frames hold about 1.3 ms of commits, if a frame is one commit *(arithmetic)*. A failover takes far longer than that to notice. So in real time a ring of 64 would rarely reach back, and (b) would nearly always fall back to (a)'s picture *(reasoned)*. A frame per commit batch would stretch the ring, but not to a failover's length unless batches are long.

**What (a) pays at a takeover, and (b) avoids when its ring reaches back** *(measured)*:
- **The frozen part.** The group's part stays at its last place while the new host builds its partial over its rows and takes the picture: 27.6 to 30.5 ms at 1e4 rows, 312 to 409 ms at 1e5, 5.92 to 7.84 s at 1e6. In the sim, groups spent 75,703 group-steps frozen this way with (a), 493 with (b) (all worlds) *(counted)*.
  - **This rests on the prototype partial** (F2), as the ring's top-10 figure does. Most of it is building O1's six-view partial: 5.26 to 7.14 s of the 5.92 to 7.84 s at 1e6 rows, about 5 to 7 µs a row *(measured)*. At one fold's 0.63 to 1.5 µs a row, the build would take about 0.6 to 1.5 s at 1e6 rows, plus the picture's 0.60 to 0.71 s *(reasoned)*.
- **The install blocks every group.** The merger runs one install at a time and takes nothing from any group meanwhile. With groups kept apart it removes only that group's entries: 0.74 to 1.24 ms at 1e4 rows a group and 7.78 to 14.0 ms at 1e5, about the same at 1, 4 and 16 groups. At 1e6 only 1 and 4 groups were timed: 174 to 252 ms with 1, 215 to 397 ms with 4, up to 1.6 times slower. In O1's one-entry form it scans every group's entries, so it grows with the number of groups: at 1e5 rows a group, 20.6 to 23.6 ms with 1 group, 84.3 to 89.2 ms with 4, 254 to 286 ms with 16; at 1e6, 464 to 631 ms with 1 and 1.49 to 1.60 s with 4. Keeping groups apart, needed for correctness (section 3), also keeps the install from growing with the number of groups.
- A resend from the ring costs 18.5 µs to 1.01 ms for 16 to 256 frames.

**What (b) costs.** Every copy runs the partial for every record, to keep its ring warm. At 50,000 writes a second per leader (PERF-09), two more copies per group *(arithmetic on measured)*:
- sums: 20 to 84 ms of CPU a second; encoded as bytes, as a ring that sends them would keep them, 80 to 131 ms. The top of each range comes from the 1e6-row run, which is shorter (50,000 records against 200,000) and noisier: the sums partial holds no state, yet it cost 0.65 to 0.84 µs a record there against 0.20 to 0.36 at 1e5;
- a top 10: 0.72 to 2.12 s. **This rests on the prototype partial** (S4): 7.23 to 21.2 µs a record, with an index step and two Maps rebuilt every commit. A partial near the cost of one fold (0.63 to 1.5 µs, E-57 A1 and E-05) would cost 63 to 150 ms a second for the two copies *(reasoned)*.
- O1's six-view partial is much worse: its max and distinct rescan the touched bucket, 514 to 559 µs a record at about 2,000 rows a bucket *(measured)*. MERGE 3.2 left that untimed. A partial needs an ordered index per bucket for max and distinct, as `data`'s views keep.

**So the pick stands: (a).** A takeover is rare, and its two costs are bounded by the group's size. (b)'s cost is paid on every record, on every copy. A warm partial on one standby copy, without a ring, would cut the frozen part; it is not built here *(reasoned)*.

**(c) as the fallback for the move's wait** (V5-20 item 12). (c) drops rule 2's pairing: a fence goes in alone, as a move part. Groups waited at a move 2.3 to 13.0 times less, and were held by a down group 1.6 to 2.6 times less *(counted)*. These are sim steps with a carry of 1 to 8 steps (S6). The real wait is the fence-to-open window, aimed at 10 ms (V5-18 pick 4) and not yet timed. Judge (c) on that timing. Beside keys by blocks of slots, (c) needs no slot placement in blocks and never tears a commit. It costs about 2 rules more than (a), and three things more at every move, not only at a takeover (F4):
- every copy of the source keeps a fenced move's rows until the move is closed at every cut a new merger could start from (section 6.1);
- each fence sends the slots' rows, or a picture of them, to the merger: 1.1 to 830 KB as JSON per move at 4,096 slots, up to 1e6 rows *(measured)*; at the sim's 1,024 slots a 64-slot move holds four times the rows, about 3.3 MB at 1e6 rows *(reasoned)*;
- the merger holds one more part for each open move, built from those rows. So in (c) the merger no longer sees only partial frames.

## 5. A pair whose partner is down

MERGE 3.2 listed "giving up a pair when its partner is down" as a missing rule. It must not exist.
- **Giving up is wrong** *(checked)*. Take the waiting unit alone after 30 steps (`giveup`): 221 and 611 seeds failed with (a) (178 and 397 on answers), 81 and 232 with (c) (all on answers). Drop the waiting half instead (`giveupskip`): 193 and 574 (179 and 413 on answers). Either way rows vanish or count twice, or the merger can never take the other half later ("stuck").
- **What the client sees** *(checked)*. Both parts frozen at their last places. That is still one exact cut: the answer checks pass at every join while groups are held. Groups were held 174,546 group-steps with (a) over the four worlds, 72,974 with (c) *(counted)*.
- **Health** *(checked)*. It names the down group, and each group it holds, by the down groups that hold it: 354,490 checks against the oracle with (a), 0 wrong. Naming only the down group (`health`) failed 428 and 771.
- **When the wait ends.** When any copy of the down group hosts its partial again. That is a takeover, so rule 4 covers it: the new host's picture carries the halves it passed.
- A fresh read waits, as V5-20 item 2 says *(reasoned; reads were not run here)*.

## 6. A new merger

### 6.1 Where its pictures start (B1)

At a rebuild each picture names the halves after a floor, and the merger joins them as at a takeover. The main lines take the floor from the dead merger's own last places, and in (c) its own closed moves. A real new merger cannot know these: the merger that held them is gone.

- **The rule.** Each ack of the merger carries its whole cut. Each group's copies keep the last one acked to them. The new merger takes the oldest of the up groups' cuts, tells every host, and every picture starts from that one cut. Every cut the old merger served is a cut (each move's two halves both in or both out), and so is the oldest of several *(reasoned)*. In (c) the same cut says which moves are closed: a copy sends a move part for every move its group fenced that is not closed at it, and so it keeps a fenced move's rows until the move is closed at every cut a new merger could start from.
- **It holds** *(checked)*. With the floor from acks, (a), (b) and (c) failed 0 of 1,000 in each world:

| World | Rebuilds | Lowered pictures (a) | Extra halves (a) | Seeds failed (a / b / c) |
|---|---|---|---|---|
| g4 | 971 | 3,823 | 1,741 | 0 / 0 / 0 |
| g16 | 971 | 13,887 | 2,079 | 0 / 0 / 0 |
| elastic | 970 | 1,726 | 874 | 0 / 0 / 0 |
| stress | 6,149 | 48,225 | 83,490 | 0 / 0 / 0 |

  A lowered picture is a rebuild picture whose floor lay below the dead merger's place; the extra halves are the ones it named below that place *(counted)*. Here a group's kept cut is one of the merger's last 64 served cuts, drawn per group.
- **Each group its own place** (`mixedfloor`) *(checked)*. As if an ack carried only the group's own place. (a) failed 107 (g4) and 732 (stress), all stuck. A's picture names a fence whose open at B lies below B's floor. B's picture does not name that open, and no frame will bring it, so the fence waits for ever *(reasoned from the intake)*. (c) never waits at a fence, so it does not wedge; it failed 76 and 878 on answers instead. A's copies, at their older cut, sent a part for a move whose open B's floor had already passed, so the move's rows counted twice.
- **A removed group** (`gonewait`) *(checked)*. An older floor can name a half whose partner's group the old merger has since removed. The merger removed it only after taking every half it held, so the half needs nothing, and in (c) a part for a move into it is closed. Waiting for it instead failed 42 (a) and 45 (c) of 1,000 elastic seeds, 84 of the 87 as stuck. The review did not name this clause; the rerun found it.
- **What it costs.** One more field in each ack (a place per group), and a round from the new merger to every host before the pictures. A lower floor names more halves: in stress, 83,490 more over 6,149 rebuilds *(counted)*.

### 6.2 While a group is down (S1)

The first run's rebuild brought every down host back. This one keeps outages through a rebuild.
- **The gap** *(counted, fix a)*. 

| World | Rebuilds | While a group was down | Gap, every group up: mean (max) | Gap, a group down: mean (max) |
|---|---|---|---|---|
| g4 | 971 | 148 | 7.9 (101) steps | 42 (117) steps |
| g16 | 971 | 148 | 35.2 (160) steps | 54 (143) steps |
| elastic | 970 | 142 | 4.8 (101) steps | 40 (120) steps |
| stress | 6,149 | 1,875 | 16.0 (155) steps | 65 (409) steps |

- An outage that starts during the gap lengthens it, which is why a gap with every group up at the rebuild can still last long.
- **Why.** The frozen part lived in the old merger's memory. A new merger can get a group's part only from a copy of that group. If none can be reached, it has nothing to serve for that group, and serving the other groups alone would show missing rows *(reasoned)*.
- **What the client sees** *(reasoned)*. Its view stays at the old merger's last frame: one exact cut, frozen for every group, not only the down one. A client that subscribes during the gap gets nothing until the group is back, and health should say why.
- **V5-20 item 2 therefore holds only while the merger that holds the frozen part lives.** Ways to close the gap, none built: keep each merger's parts on a second server (a standby merger fed the same frames); let a client keep its last frame and treat a rebuild as a pause; or accept the gap and state it. This is an owner question (section 11).

## 7. Rule counts

Counted as MERGE counts them *(reasoned)*. Each piece has a planted bug that fails (section 3) *(checked)*.

| Piece | Why | (a) | (b) | (c) |
|---|---|---|---|---|
| Rule 2's closure | a pair's partner can sit behind other halves | +0 to +1 (O1 had a weaker form) | same | same (an open brings its fence) |
| Keys kept apart per group | a join applies several groups at one cut | +1 | +1 | +1 |
| A picture carries its halves | rule 4's case; at a rebuild too | +1 | +1 | +1 (with rows; every copy keeps them until the move is closed at every kept cut) |
| The join for a picture with several halves | | +1 | +1 | +1 |
| A new merger starts every picture from one cut of the old merger | it cannot know the dead merger's places; per-group floors wedge (a) and count rows twice in (c) | +1 to +2 | +1 to +2 | +1 to +2 |
| The resume rule | the ring must reach back | | +1 | |
| The move part | a fence goes in alone | | | +1 |
| An open waits for its fence | | | | +1 |
| A new merger gets its move parts back | | | | +1 |
| Rule 2's pairing | | kept | kept | −1 |
| **Total** | | **+4 to +6** | **+5 to +7** | **+6 to +8** |
| Health names held groups | already in MERGE's list | +1 | +1 | +1 |

Of each total, rule 4 itself is +2 in (a), +3 in (b) and +4 in (c), with the pairing's −1 already in (c)'s +4 (N6). The floor at a rebuild is +1 to +2: the one-cut rule, and its clause that a removed group is past every half it held, which may count on its own. In (c) the same cut says which move parts are still open, so it adds no rule there *(reasoned)*. The rest (closure and keys apart, +1 to +2) is rule 2's real form, owed in every form.

**Keys kept apart: new, or a swap?** E-23 had "each key from exactly one group"; E-64 found it never fires once a move's halves are taken together (O1-2), and MERGE 2 says so. So MERGE's +7 most likely does not count it, and keys kept apart is a new rule (+1). If it did count it, keys kept apart replaces it, and every total here, and MERGE's net, is one lower *(reasoned)*.

**MERGE's net** *(reasoned)*. MERGE 3.2 counts about +9 to +14 net, with rule 4 as one rule and "giving up a pair when its partner is down" as another. Now rule 4 is +2 (one more), rule 2's real form adds +1 to +2, the floor at a rebuild adds +1 to +2, and the give-up rule goes (one less). So about **+11 to +18** (+10 to +17 if keys kept apart is a swap).

## 8. What should change in MERGE.md and LAYERS

Proposed only. Those pages are tracked and were not edited here.

**MERGE.md**
- **0, item 6** and **2, rule 4**: replace "not yet run on seeds" with the form that passed: a picture names every half between its floor and its own place, with rows or not, and the merger installs it with each half's partner, at one cut (E-67: 0 of 4,000 seeds failed). The floor is the merger's place at a takeover. At a rebuild it is one cut of the old merger: each ack carries the merger's whole cut, each group's copies keep the last one acked to them, and the new merger takes the oldest of the up groups' cuts and tells every host before the pictures. A removed group counts as past every half it held. Each group starting from its own place wedges the merger (E-67 `mixedfloor`).
- **2, rule 2**: add its real form: the closure (each half met on the way to a partner brings its own), and each group's window and filter rows kept apart. Strike "E-23 also had 'each key from exactly one group' ... it never fires": with joins across groups, one entry per key fails; keys are kept apart instead.
- **3.2, Rules**: strike "giving up a pair when its partner is down" (it is wrong); rule 4 counts +2, the rebuild floor +1 to +2, and rule 2's real form +1 to +2; the net becomes about +11 to +18 (one lower if keys kept apart only replaces E-23's key rule).
- **3.2, What a client sees**: a group whose next half needs a down group is held too, frozen at one exact cut; health names both. And through a merger rebuild, a group that is down stops the whole view until it is back (section 6).
- **3.7, the ring**: it fixes rule 4's case only with (a) behind it, and never at a rebuild; its cost per copy; and in real time 64 frames hold about 1.3 ms of commits, so it would rarely reach back over a failover (section 4).
- **3.2, Cost**: the partial's max and distinct, as built, rescan a bucket: 514 to 559 µs a record at about 2,000 rows a bucket.
- **5.3 item 4** and **5.4 item 7**: as above. **4, combination D** and **question 7**: name (c) beside blocks of slots as the fallback for the move's wait, with its costs at every fence: the slots' rows sent to the merger, a part held there while the move is open, and the rows kept on every copy until the move is closed at every kept cut.
- **6 item 1**: done by E-67. Owed from it: the merger on real sockets (6 item 5), `data`'s views as the partials, the move's window timed (6 item 6), and the rebuild gap (section 6.2).

**LAYERS.md**
- **The row "A resource larger than one server's memory"** (section 10's list): "E-23's merger and its four rules" becomes the merger with rule 4 in form (a), checked on seeds (E-67).
- **8.6 item 7**: a served view merged across groups sees a slot move as two halves taken at one cut; a partial's takeover carries the halves it passed; a new merger starts every picture from one cut of the old merger.
- **4.6, owed**: the seeded merger on real sockets; the rebuild gap while a group is down; a partial whose max and distinct keep an index.
- **4.3**: the merger's rules (+4 to +6, plus health) join the count where MERGE's rules are counted.

## 9. How the numbers compare with the first run

The first run's files were lost, so its world's exact rates are not known. This run rebuilt the world from the first run's design; the safety results reproduce, and the rates differ.

| Claim | First run | This run |
|---|---|---|
| O1's three rules: seeds failed (g4, g16, elastic, stress) | 633, 416, 773, 1,000 | 366, 114, 321, 923 |
| (a): seeds failed | 0 in every world | 0 in every world |
| (a): checks; moves; takeovers; outages; rebuilds; case pictures | 1,943,876; 103,479; 39,296; 8,383; 8,785; 31,032 | 2,066,979; 93,389; 46,257; 7,395; 9,061; 11,765 |
| Closure off (g4, stress) | 195, 997 | 211, 916 |
| One entry per key (stress, a) | 146 | 478 |
| (b0) (g4, g16, elastic, stress) | 135, 165, 306, 999 | 59, 16, 83, 583 |
| Ring covered: 64 frames; 16 frames | 97.4 to 100 %; 78.5 % | 96.3 to 100.0 %; 84.8 % (elastic), 98.6 % (stress) |
| (c): seeds failed | 0 in every world | 0 in every world |
| (c) against (a): waits at a move; held | 3 to 7 times less; 1.8 to 2.5 times less | 2.3 to 13.0 times less; 1.6 to 2.6 times less |
| Give up after 30 steps: (a) g4, stress; (c) g4, stress | 249, 709; 162, 524 | 221, 611; 81, 232 |
| A picture takeover | 36 ms to 6.2 s | 27.6 to 30.5 ms at 1e4 rows, 312 to 409 ms at 1e5, 5.92 to 7.84 s at 1e6 |
| A resend from the ring | 10 µs to 7.7 ms | 18.5 µs to 1.01 ms |
| A move part | 0.2 to 33 ms; 3 to 943 KB | 0.4 to 31.2 ms; 1.1 to 830 KB |
| The install, one group, 1e6 rows | 1.26 to 1.46 s | 464 to 631 ms (one entry per key), 174 to 252 ms (groups kept apart) |
| Ring CPU, two more copies at 50,000 writes a second: sums; top 10 | 44 to 45 ms; 0.55 to 0.66 s | 20 to 84 ms; 0.72 to 2.12 s |
| Rules: (a); (b); (c) | +3 (3 to 4); +4 (4 to 5); +5 (5 to 6) | +4 to +6; +5 to +7; +6 to +8 (the rebuild floor added) |

Where they differ, and why *(reasoned)*:
- **Fewer seeds fail under O1's rules here**, most in g16. Here a takeover lands on one of the groups, picked from all of them, so with 16 groups each group's partial fails less often, and fewer pictures pass a waiting half. Also about a third of moves are of one slot, and with 300 keys over 1,024 slots most of those carry no rows; a passed half with no rows changes no answer. It still wedges the merger if the picture does not carry it: 39 of the 40 seeds that failed with only such halves failed stuck.
- **(b0) fails less** in the three mild worlds. Here a new merger takes each picture as it comes and keeps taking the frames of the groups it has. A half that a lone picture passed is often taken alone before the last picture arrives, which repairs the cut before the merger serves. In stress it still fails in most seeds.
- **The ring covers more at 16 frames** in stress here: stress has 8 groups, so an outage of up to 140 steps is about 17 commits a group. In elastic 16 frames covered 84.8 %, near the first run's 78.5 %.
- **The takeover's picture at 1e6 rows is slower** (5.92 to 7.84 s), and the install with one group faster. The first run's exact shapes for these were not kept.
- **The prototype top 10 costs more a record** here (7.23 to 21.2 µs), so the ring's top-10 figure is higher.
- **One entry per key fails more here** (478 against 146 in stress). This run applies a join's groups in a seeded random order, which meets the bad order more often.
- **(c)'s gain in waits spreads wider** (up to 13 times in g16). With 16 groups each group sends few frames, so under (c) an open seldom finds its fence still behind; under (a) a fence still waits for its open's whole carry.

## 10. Limits, and what the reviews changed

**Limits.**
- **The three-commit move** (S6). V5-18 pick 4 cut the move to one commit (E-17b's fused form: A's fence is the decision, and B's one entry is the final copy, which opens the slot). This study runs the three-commit form. The merger sees the same halves in both: A's fence, then B's open, or B's give-up and A's unfence. So the safety results carry over *(reasoned)*. The waits are sim steps with a carry of 1 to 8 steps; with the fused move the fence-to-open window is a few milliseconds, so the waits (a) pays may be much smaller in real time, and (c)'s gain with them.
- **One process.** Queues stand for links; no Raft; no `data`. The partials are O1's plain code, not `data` 5's views.
- **The world's rates are this study's own** (section 9). g4 and g16 share their fault draws: the same steps bring a takeover, an outage or a rebuild, though the group it hits differs (N2).
- **"No failing seed without the case"** is tested on few seeds in stress: 2 of 1,000 had no picture past any half there (N2).
- **Full checks** come every 25 joins and after every picture; between them only touched keys and buckets are checked, so a wrong value elsewhere could heal unseen for up to 24 joins (N3).
- **The health oracle** reads the world's move table and the merger's places, not the intake's lists, but follows the same definition of "held". A shared misreading would hide in both. The planted bugs that change the join (`nopair`, `noclosure`, `nojoin`, `noorder`) run without the health check, so they fail on answers (N4).
- **Giving up** was run in two forms: take the unit alone, and drop the waiting half. Removing the down group's whole part was not run; its rows would vanish (N6).
- **The bench** keeps frames as JSON strings when it times a ring of bytes (N7). Rows are small (three fields). The install was timed with a picture that changed 1 % of the group's rows.
- **Reads** (`{ pages }`, a fresh read that waits) were not run.
- **A new host is never behind the merger's place** (N7). The world always puts it at or past that place, as O1 assumes ("the new host waits until it is at or past the merger's place"). That wait is assumed, not run: the intake has no way out of a picture behind its place and would wait for ever.
- **The floor from acks is a model.** The acks are not sent as messages: each group's kept cut is drawn from the merger's last 64 served cuts. A cut kept longer ago only lowers the floor further, which the rule allows; it was not run.
- **The ring's coverage** is in the sim's rate of one commit a step (F3); in real time it would be far lower.

**What the first review changed** (the first run's review, folded in at the rebuild):
- **S1**: outages stay through a rebuild; the gap is reported (section 6.2).
- **S2**: the closure is split: rule 2's part and rule 4's join, each with its own planted bug and its failures in seeds without the case (sections 3 and 7).
- **S3**: the pick names (a)'s two takeover costs, and the install is timed at 1, 4 and 16 groups (section 4).
- **S4**: the ring's top-10 figure is marked as the prototype's and scaled to a fold's cost (section 4).
- **S5**: every copy of the source group keeps a fenced move's rows until the merger closes the move; a planted bug (`droprows`) checks it.
- **S6**: the three-commit form and the sim-step waits are stated (above, and section 4).
- **N1**: groups removed are counted when removed (792 in elastic, fix a), not when a shrink starts.
- **N2, N3, N4, N7**: stated above. **N5**: the queue is called the merger's inbound buffer, dropped at a takeover. **N6**: `giveupskip` added.

**What the second review changed** (a review of the rebuild; every seeded line was rerun after it):
- **B1, the floor at a rebuild.** The rebuild's pictures started from the dead merger's exact places, and in (c) the copies knew its exact closed moves. A real new merger cannot get these. The study now names the rule (one cut of the old merger, kept from its acks), runs it in every world for (a), (b) and (c), and plants its bug (`mixedfloor`: 107 and 732 with (a), against the review probe's 96 and 735; 76 and 878 with (c), where the probe, whose copies still knew every closed move, found none). In those lines the copies know only the closes at the chosen cut, and keep the moves the world had forgotten once taken. Running the rule found one clause the review did not name: a removed group is past every half it held (`gonewait`). The counts rise by +1 to +2 in each form (sections 6.1 and 7).
- **F1, stuck is a wedge.** Tables 1 and 3 give failures on answers and "stuck" apart. The case has one definition (any half; "with rows" where it matters). A passed half with no rows must still be carried (sections 0 and 3).
- **F2**: the frozen part's cost is marked as the prototype partial's and scaled to a fold's cost (section 4).
- **F3**: the ring's coverage is the sim's rate; the real-time arithmetic is given (sections 0 and 4).
- **F4**: (c)'s cost at every fence, the rows sent and the part the merger holds, is named (section 4).
- **N1**: section 0 item 8 (item 7 before) now marks the gap *(counted)* and *(reasoned)*. **N2**: the install at 1e6 rows names 1 and 4 groups only. **N3**: the move part's slots are "of 4,096". **N4**: the six-view resend is left out, and the 1e6 sums run is named as the noisy top of its range. **N5**: the ring's size sweep runs in elastic, where 64 frames missed. **N6**: the rule counts say what rule 4 itself costs in (c), and whether keys kept apart is new (section 7). **N7**: stated above.

## 11. Questions for the owner

The owner answered these on 2026-11-23 in [V5-22](../../../DECISIONS.md), each as picked: the gap through a rebuild is stated and a standby merger is studied later (its item 4); (c) is a second fallback beside keys by blocks of slots; which one, if either, is chosen on the timed fence-to-open window, and neither is in the first build (item 5); and section 8's edits are made in the V5-20 rewrite, with MERGE's net at about +11 to +18 (item 6). The questions stand as they were put.

1. **A new merger while a group is down.** V5-20 item 2 keeps a merged view serving with a down group frozen, but a merger rebuilt during that outage has no part for the group. Pick: state the gap (the view stays at its last frame until the group is back) and study a standby merger later. Other way: a standby merger fed the same frames, in the first build.
2. **(c) as the fallback for the move's wait**, beside or before keys by blocks of slots (V5-20 item 12)? Pick: yes, judged on the timed move window.
3. **The MERGE.md and LAYERS edits** in section 8, which now carry the rebuild floor (one cut of the old merger, from its acks; +1 to +2 rules, MERGE's net about +11 to +18): apply them?

## 12. How to run, and the files

```
./run.sh quick    # a smoke run: a few lines of 20 seeds and one bench part, nothing written
./run.sh sim      # the 81 lines of 1,000 seeds (results/sim.jsonl)
./run.sh bench    # the timings, three runs (results/bench.jsonl)
./run.sh S        # the tables (results/summary.md)
./run.sh full     # sim, bench, S
```

`SP` names a folder holding `bin/heavy` and `bin/timing` lock wrappers, if there are any; `PAR` (default 3) lines run at once; `SEEDS` (default 1000). One seed with its counters: `node sim/sim.mjs --world=stress --fix=a --seed=7 --seeds=1 --trace`. The rebuild floor from acks: `--floor=acked`. Each process stays under 3.5 GB.

- [src/lib.mjs](src/lib.mjs), [src/partial.mjs](src/partial.mjs): from E-64 O1 (one import path changed in lib.mjs).
- [src/merger.mjs](src/merger.mjs): O1's merger, with groups kept apart and a whole-part drop.
- [src/intake.mjs](src/intake.mjs): the merger's rules in each form; the planted bugs on its side.
- [sim/sim.mjs](sim/sim.mjs): the world, the oracle, the rebuild floor, the planted bugs on the world's side.
- [bench/bench.mjs](bench/bench.mjs), [bench/summarize.mjs](bench/summarize.mjs).
- [results/sim.jsonl](results/sim.jsonl), [results/bench.jsonl](results/bench.jsonl), [results/summary.md](results/summary.md).

Sources: [MERGE.md](../../MERGE.md) sections 3.2, 3.7, 5 and 6; [DECISIONS](../../../DECISIONS.md) V5-18 and V5-20; [E-64 O1](../E64-past-one-process/O1/README.md) and its [probe](../E64-past-one-process/probes/move-failover.mjs); [LAYERS.md](../../LAYERS.md) 8.6.
