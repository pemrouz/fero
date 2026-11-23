# Many groups per resource: what changes

2026-11-21. In v5 a resource's rows hash into 4,096 slots, and slots belong to Raft groups (V5-2). The pages often say "the first build has one group per resource", and many readings rest on what that gives. This page finds every place where the design, its promises, its costs, its rule counts or its evidence lean on one group per resource, or on one server holding a whole resource, and says what happens with many groups. The owner asked for this check before any code is written, because the step from one group to many could undo decisions made on the one-group picture.

**How it was made.** Five passes read the decisions, [API.md](API.md), [LAYERS.md](LAYERS.md) with [PATHS.md](PATHS.md) and [MEMORY.md](MEMORY.md), the read and transform pages ([TRANSFORMS.md](TRANSFORMS.md), [CONNECT.md](CONNECT.md), [ANYPATH.md](ANYPATH.md), [PATTERNS.md](PATTERNS.md)), and the experiments. They found 324 places. A merge folded them into 82 items. A skeptic then checked the merge against the sources. What held is taken here:
- G2 and G3 became COST: API.md already reads the spare case, and V5-16's words were already wrong for a spare.
- G5 is narrower: TRANSFORMS and LAYERS 9.4 state the one-process ceiling; only API.md's list and SC-10's list miss it. G6's number was wrong.
- H11 and H12 were misread: the home-log form adds no commit to E-13's number, E-13 sent no bytes, and a cut form is partly modelled already.
- Two items were added: G10 (by default five servers fold every write) and R5 (SC-05's wake).
- The plan's first step needed more servers in its tests, two more pieces, and an honest note on SC-03. The rule sums were redone item by item.
- This page also found that [E-11] and [E-13] did spread leaders over three processes, at the Raft level only (R3, R4).

**Amended 2026-11-23 for V5-18, V5-20 and V5-22** ([DECISIONS](../DECISIONS.md)). Every question in section 5.5 now has an answer, given there with its decision. V5-18 took the first slice with several groups and most of the readings. V5-20 answered what V5-18 left for MERGE.md: there is no fixed row ceiling and the merger ships in the first build (G5, G6), served views live on any server that holds their rows, preferring one that leads no group (V1, question 6), and a live merged view keeps serving while a group is down, which changes V5-18 pick 5 (P5). V5-22 states the gap through a merger rebuild. The items below keep their findings as written, with a **Decided** line where a decision answers them. The line numbers were moved to the pages as they stood on 2026-11-23.

**How each claim is marked.** **checked**: a named source says so, or a named model checked it at small bounds. **measured**: a named experiment's number. **reasoned**: an argument; nothing ran it. **a guess**: a number nobody measured or worked out. A line number such as `API.md:260` points at that page as it stood on 2026-11-23, after the V5-20 rewrite; the cites were first written against the pages of 2026-11-21 and moved then. [DECISIONS](../DECISIONS.md) holds V5-1 to V5-22; [DESIGN-V5](../DESIGN-V5.md) is the older draft. Other page names ([AMENDMENTS.md](AMENDMENTS.md), [REQUIREMENTS.md](REQUIREMENTS.md), [SIMPLICITY.md](SIMPLICITY.md), [VERDICT.md](VERDICT.md)) are files in this folder.

## 0. The answer

1. **84 places** in the design lean on one group per resource, or on one server holding a whole resource (merged from 324 finds; section 2).
2. With many groups, **21 break**, 24 hold but cost more, 30 need a model or a measure, and 9 hold as written.
3. **Worst:** all work over every row needs one process that holds and folds the whole resource. Past about 1e6 to 5e6 rows it cannot run, past about 5 leaders' writes it falls behind, and API.md's list of limits says neither (G5, G6). *Answered by V5-20 items 1 to 5: the merger, `scan()` and folds, with no fixed row ceiling.*
4. **Worst:** served views "never on a leader" fight leaders spread over servers (V1, H7). *Answered by V5-20 item 13.*
5. **Worst:** the home group is the only map and the only mover. While it is down, new clients cannot find live groups, and a slot caught mid-move takes no writes until it returns (H1, H4).
6. **Worst:** growth is not ready. A new group starts with one voter and gets slots at once, nothing adds a group by size, and the move misses its 10 ms bar (H6, H9, H11).
7. **Worst:** by default every write is folded on 5 servers. So groups spread nothing on 5 servers or fewer, and writes scale to about 0.58 × n, under SC-03's 0.7 × n (G10).
8. **Recommendation:** found every resource with several groups in the first build, and test on 6 or more servers (or `standbys: 0`) so some servers hold only part of a resource.
9. Bring the slot move in last, in the same slice, once its model passes and its window is timed with a real carried set.
10. **Cost:** about +6 to +26 builder rules on 446 to 503 (1 to 6 %), +1 in `data`, +2 to +4 user rules (reasoned); 6 to 11 weeks of models, 3 to 5 if run side by side (a guess).
11. One group first saves none of those rules: they come later, plus a rebuild of the read surface and a second `data` major version (reasoned).
12. Twelve questions for the owner end section 5, most important first. V5-18 and V5-20 have answered them all (5.5).

## 1. Words

- **Slot.** One of a resource's 4,096 fixed hash buckets; a row's partition key picks its slot (V5-2).
- **Group.** One Raft log with one leader; it owns some of a resource's slots.
- **Partition.** The rows one leader keeps in one order; it sits in one slot, so in one group at a time.
- **Copy.** One server's full replica of one group: the group's log on disk and its rows in memory.
- **Voter.** A copy whose disk counts toward a commit; `copies` (3 by default) says how many.
- **Standby.** A copy that does not vote; `standbys` (2 by default) says how many, so a group has 5 copies by default (API.md:260, :2476).
- **Holder.** Any server with a copy of a group, voter or standby.
- **Spare.** A server that holds no copy of a group; today a spare holds nothing of the resource, and with many groups a server can be a spare for some groups and a holder of others.
- **Partial server.** A server that holds some of a resource's groups but not all; with one group per resource there are none.
- **Placement.** The list of machines a group's voters should sit on, kept in the group's log, with one **preferred member** that should lead when all are up.
- **Slot move.** Handing one slot from group A to group B: A fences the slot, B gets a copy and opens it (LAYERS 8.6).
- **Window.** The time a moving slot takes no writes: from A's fence to B's open.
- **Carried set.** The state a move hands over beside the rows: the slot's sequence and epoch, sessions, lock fences, marks and segment names (A-17).
- **Home group.** A resource's first group; its log holds the settings, the slot table and one record per group, and its leader decides moves.
- **Whole-resource work.** A feature that needs every row in one process: served views, `{ pages }`, root operators, a handler's `ctx.data` over every row, `f.data.connect()`, `hold: 'all'`, `derive`'s view form, `migrate`'s scan.
- **R0, R1, R2.** TRANSFORMS 3.9's rules: a process doing whole-resource work keeps one store fed by every group and takes any slot it lacks as `hold: 'all'` does (R0), and two fold rules keep that store exact through moves (R1, R2).

The four classes:
- **HOLDS**: true with many groups as written.
- **COST**: still true, but it costs more; the item says what.
- **BREAKS**: a promise, rule or decision is wrong with many groups; the item gives the smallest change.
- **UNKNOWN**: needs a model or a measure first. Sizes are guesses: **S** up to 2 days, **M** 3 to 5 days, **L** 1 to 2 weeks.

## 2. Every item, by theme

Each item says what it assumes, where, what changes with many groups, its class, and what it needs. HOLDS items are short.

### 2.1 What a server holds, and work over every row

**G1. BREAKS. "A server holds every row."**
- *Assumes:* a server of a resource holds all of it, so "copy", "standby" and "spare" mean the whole resource.
- *Where:* API.md:52, :167, :177, :186, :260-263, :267, :2476; LAYERS:72, :838, :850-853, :891-894; CONNECT:7, :30, :90; ANYPATH:5; PATTERNS:20; TRANSFORMS:7, :160, :220.
- *With many groups:* a server holds only the groups placed on it. Once a resource has more than `copies + standbys` servers (5 by default), most servers are partial. A `get()` there is local or one trip, by placement, and neither the user nor the types can tell which. (checked: API.md:260 says "a server holds every row or none" because the first build has one group)
- *Needs:* a copy is one group's replica; "held on purpose" means this process holds the slot's group, `hold: 'all'` or a live link; the role text gains the partial server. +0 builder rules, +1 user rule. Touches V5-12's review rule, V5-16 pick 2's words, API.md question 28.

**G2. COST (the merge had BREAKS). Root operators and `ctx.data` on a server that lacks groups.**
- *Assumes:* the `'server'` role sees every row, so root operators, `ctx.data` over every row and root calls "to any server" are local.
- *Where:* API.md:142, :262, :968, :977, :1633 (`Mode 'server'`), :1730-1733 (`RootOps`), :2959 (question 28); LAYERS 10 item 46; DECISIONS V5-12 picks 3 and 13, V5-16 pick 3.
- *With many groups:* a partial server first downloads each group it lacks (R0). API.md already says this for a spare: "the line works on every server, and only its cost depends on the deployment" (checked: API.md:262). So no promise breaks. The same line costs differently on each server, and past one process it cannot run at all (G5) (reasoned).
- *Needs:* confirm that the spare reading covers partial servers, and say the download on the line. 0 rules. Its cost is G4's measure.
- *Decided* (V5-20 items 1 and 3 to 5, which close API.md question 28 and this page's question 12): one-time work over every row reads by `scan()`, with no download; live work that merges or folds is served per group; only a sync read of every row, and live code that is not a fold, take what the server lacks, under its `memory`.

**G3. COST, with a wording fix owed anyway. `f.data.connect()` on a server "sends no subscription of its own".**
- *Where:* DECISIONS V5-16 pick 2 and its REJECTED line; API.md:256, :2529 (P-01), :2727 (P-12).
- *With many groups:* on a partial server the handle subscribes to every missing group and downloads it. The words are already wrong for a one-group spare, and V5-16's own REJECTED line reasons from that spare (checked: DECISIONS V5-16). Many groups make the case common.
- *Needs:* pick 2 reads "with `hold: 'all'`, or on a server that holds every group"; P-01's and P-12's comments name the cost. 0 rules.

**G4. COST. R0 is free only with one group.**
- *Where:* TRANSFORMS:32, :124, :280, :315 ("In the first build R0 is free"), 10 item 10; LAYERS:532, :1040, 9.4; PATHS:869 (PA-19), :1226; API.md:173, :188.
- *With many groups:* each process with whole-resource work takes a picture of every group it lacks, then decodes and folds every write of every group for as long as it lives. It holds the whole resource: about 330 B a small row (measured, [E-05]), so about 330 MB at 1e6 rows (arithmetic), downloaded again after each restart. A read over every row wakes every dormant group: 20 groups in 10 to 16 ms (measured, [E-26]). How a subscribed group's import reaches the store is not written (+0 to +1 rule).
- *Measure:* E-57 B1's cost run on real links, with a server missing 1 of 4 and 15 of 16 groups, at 1e5 and 1e6 rows: bytes, time under the byte-rate cap, memory, fold CPU, R2 bytes per move. **M**. V5-16 already owes this measure for a spare.
- *Decided* (V5-20 items 1, 3 to 5): R0's download now serves only a sync read of every row and live code that is not a fold, and it is bounded by the process's `memory`, counted as RSS (about 1.4 M small rows a GB), not by a row count. The measure is still owed.

**G5. BREAKS. A resource bigger than one process loses every whole-resource feature, and API.md's limits do not say so.**
- *Assumes:* some process can always hold every row.
- *Where:* TRANSFORMS:32, :321 ("When a real merger is needed"), 10 item 1; LAYERS 9.4; API.md:142, :262, "Sizes and stated ceilings" (:2315-2322); DECISIONS V5-14's frame and REJECTED line ("a merger across partitions"); REQUIREMENTS SC-06, SC-10.
- *With many groups:* outgrowing one process is a main reason to have many groups. Then R0 fails, and served views, `{ pages }`, `derive`'s view form, root operators, `ctx.data` over every row, `f.data.connect()`, `hold: 'all'` and `migrate`'s scan all stop (reasoned).
  - The edge is about 1e6 rows of 2 KB to about 5e6 small rows at Node's default heap (checked: SC-10's own figure; [E-34] held 5e6 small rows in 1.7 to 2.0 GB), and 16,777,216 rows per `data` source whatever the heap (measured, E-34).
  - TRANSFORMS 3.9, its 10 item 1 and LAYERS 9.4 state the edge as "not covered". API.md's list of ceilings and SC-10's list do not, and SC-10 says an unlisted ceiling fails (checked).
  - TRANSFORMS names E-23's merger "the design" only for this uncovered case, so it does not clash with V5-14's REJECTED line (checked).
  - API.md's promise that "the line works on every server" fails past the edge (reasoned).
- *Needs:* list the ceiling in API.md 7 and SC-10 ("whole-resource work needs the resource to fit one process: N rows, M GB"). Check it when a view is declared and as data grows, and warn at 80 %. An owner rule for what a live served view does when its resource grows past it. Keep E-23's merger (four rules) as the later design for SC-06. +1 builder rule, +1 user rule.
- *Decided otherwise* (V5-20; [EVERYROW.md](EVERYROW.md) and [MERGE.md](MERGE.md)). No feature has a fixed row ceiling (item 3; a fixed ceiling is rejected). The merger ships in the first build for every whole-resource view that merges (item 1; its rule 4 passed, V5-22 item 1). One-time work over every row is `scan()` (item 4), live code a fold per group (item 5), and a live median a sorted column at the merger (item 6). A sync read of every row is bounded by the process's `memory`: health warns at 80 %, a hold that will not fit is refused at open, and a live hold past the line ends `not-held` (item 3). `data`'s 16,777,216 rows a source is lifted in `data` 5 (V5-21 item 2).

**G6. BREAKS. A reader of every row caps the resource's write rate at one process.**
- *Assumes:* a split resource scales its writes: "about 135 leaders' worth" (API.md:2317).
- *Where:* API.md:781, :2317; TRANSFORMS 8.2 ("every live served view sees every write"); LAYERS:624, :772, :790; DECISIONS V5-12's review rules ("the four-line derive runs in one process").
- *With many groups:* a served view's host, a view-form deriver, a `hold: 'all'` holder or a root `changes()` reader folds every write of every group on one main thread.
  - With no view that is about 280,000 records a second, about 5 leaders' worth (arithmetic on E-05's 3.6 µs decode and fold, [E-05]).
  - With one leaderboard at 5,000 rows, each change costs 12.2 to 15.7 µs more (measured, [E-57]): about one leader's worth.
  - So "about 135 leaders' worth" holds only for a resource with no such reader, and that ceiling is not listed (reasoned).
- *Needs:* list it beside G5's; point big sources to `derive`'s record form with shares. 0 builder rules; the user rule is G5's.
- *Decided, in part* (V5-20 items 1, 5 and 10): a served view or a fold is merged, so no process folds every write for it; each group's copy works on its own rows. A `hold: 'all'` holder and live code that is not a fold still fold every write on one main thread. `derive`'s view form follows the merged view, with a stated bucket limit (about 1.6e5 at 16 groups); past it, the record form.

**G7. BREAKS. `data` 5 has no way to work on one slot's rows.**
- *Assumes:* a server holds one group, so its store is that group's rows.
- *Where:* LAYERS 3.7 (the D and N lists; N9 is a key iterator, not by slot), :678 ("no merger across groups"); TRANSFORMS 9; DECISIONS V5-14 pick 6.
- *With many groups:* a partial server with one store per resource (R0's form) must cut one group's snapshot, install it, drop a removed copy's rows, and take or drop one slot at a move. With one store per group instead, local reads over every row need a merge across stores, which `data` will not have (checked: LAYERS 3.7). Either way a move must take one slot's rows out of a store. One group and no move never meet this (reasoned).
- *Needs:* add "rows by slot: list, snapshot and drop one slot's rows" to data 5.0.0's list, and say one store per resource per process. Or fero keeps its own key-to-slot index, at a cost in memory per row. +1 rule in `data` (or in fero). Touches V5-14 pick 6.

**G8. COST. A read on a server is local or a trip, by placement.**
- *Where:* PATHS 4.4 (:761); API.md:526, :564, :2267.
- *With many groups:* a `get()` of a partition in a group this server lacks costs a `moved` round trip. Past `copies + standbys` servers that is the usual case for one-link clients (checked: PATHS:761 finds no gap only "when every server holds every group").

**G9. COST. A room or a partition is still one leader's work and one server's memory.**
- *Where:* ANYPATH:82, :94, :117-119; API.md:232.
- *With many groups:* groups do not help one big room. A move of its slot copies all of it (sent three times and folded three times as drafted, LAYERS 8.6), and a room write during the move gets `retry` (reasoned). SC-10 lists "one partition = one writer" but not the room's memory (checked).

**G10. BREAKS (new; reasoned). By default five servers fold every write, so groups spread little.**
- *Assumes:* more groups spread writes and memory over more servers.
- *Where:* API.md:260, :267, :2476 (`copies` 3 and `standbys` 2: 5 holders); DECISIONS V5-6 ("`data` folding on every copy"); PATHS:656 ("five server folds per write"); REQUIREMENTS SC-03, SC-06, PERF-09.
- *With many groups:*
  - Each write is decoded and folded on every holder of its group: 5 by default (checked: API.md:260).
  - A follower's decode and fold is about 3.6 µs a record (measured, [E-05]). PERF-09's 50,000 writes a second per process leave 20 µs a write (arithmetic). So one write costs about 1 + 4 × 0.18 = 1.72 leaders' work.
  - Then n servers give about 0.58 × n writers' worth, under SC-03's 0.7 × n; with `standbys: 0`, about 0.73 × n (reasoned, before the followers' Raft and fsync work, which make it worse).
  - On 5 servers or fewer every group sits on every server. Groups then spread neither memory nor fold work, and no server is partial (checked from the defaults). A 10 GB resource still sits whole in every process (R5).
- *Needs:* an owner pick: `standbys` defaults to 0 once a resource has more than one group (or shrinks as groups are added). State the fold cost per holder. Test worlds need 6 or more servers, or `standbys: 0`. 0 rules (a default). Touches API.md's `standbys` default (API.md's own reading), V5-6, SC-03, SC-06. Measured by R4's run with 3 and 5 holders.

### 2.2 Order, time and transactions across groups

**O1. COST. A one-group build shows more order than fero promises.**
- *Assumes, without saying:* one leader orders every write of a resource.
- *Where:* DECISIONS V5-1; API.md:141, :669-674 (P-06, P-07), :1845, :2282, :2305-2307 (P-10); TRANSFORMS N-1 (:99), rule 4 (:593); CONNECT:176; ANYPATH:118; MEMORY:851; LAYERS:636.
- *With many groups:* with one group, a reader of every row sees one total order; a turn's writes to two partitions share a commit; a lock's fence covers every partition after the new holder's first write; an early answer orders writes across partitions. With many groups all four go. Nothing promised them, but apps, libraries, example checks and tests can come to lean on them (reasoned). The test world shuffles partitions, and a planted app failed 25 of 100 seeds there (measured, [E-22]); a real one-group cluster would not catch it.
- *Costs:* every test tier and example runs with at least two groups per resource; the shuffle covers links over every row and root `changes()`; lock fencing is written "per group".

**O2. BREAKS. P-16: "a rebuilt projection equals the live one".**
- *Where:* API.md:2810-2815 (P-16); P-07; TRANSFORMS 10 item 15.
- *With many groups:* a root reader interleaves groups differently on each run. So a projection that depends on order across partitions (a float sum, a list, "the last event") differs between live and rebuilt. With one group there was one log order (reasoned).
- *Needs:* "equal for projections that fold each partition on its own, or whose result does not depend on order across partitions". 0 rules. Touches P-16's text only.

**O3. BREAKS. Writer time "never going back" holds per group only.**
- *Where:* DECISIONS V5-4; LAYERS:546 (`writer-time`: "never going back, across a handover too"), :637, :731, :787; CONNECT:225-227; API.md:68, :2289-2293, P-02, P-09, P-10, P-13, P-22; PATTERNS:38, :246-251, :292, :297; ANYPATH:87; AMENDMENTS K-11, G-11.
- *With many groups:* after a move, a slot's stamps come from B's median clock. If B is behind, time steps back inside the partition. If B is ahead, a TTL, lease or delayed job can lapse early, by up to the two groups' gap. So "at most one live lease per job" and "never before its time" hold only inside one group (reasoned). A-17's carried set has no stamp, and K-11 already lists "the last stamp of a slot" as an untested crossing (checked). [E-21] ran one group with fixed members.
- *Needs:* the move carries the slot's last stamp, and B never stamps that slot lower. Say that an early lapse is bounded by the groups' gap (within `skew.max` while clocks are sound). +1 rule. Model: K-11 on E-21's simulation, with a move between groups that have different members. **S**. Touches V5-4, A-17.

**O4. COST. V5-4: "within a resource it uses the log's exact order".**
- *Where:* DECISIONS V5-4; API.md:2293; LAYERS:787.
- *With many groups:* groups of one resource are as unordered as two resources. The viewer merges G streams per resource (or up to 4,096 slot streams) and keeps each slot's order. The words become "within a group" (reasoned).

**O5. HOLDS. Inside one partition, and no atomic writes across partitions.**
- V5-1 gives up transactions across partitions; `batch` is one partition; a root write is refused (V5-15 pick 3); a room is one partition; guards and the shape rule run at the slot's leader. *Evidence:* [E-15], [E-19], [E-22], [E-24], [E-58].

**O6. HOLDS. One commit point per group, and byte paths shared across groups.**
- Each group commits on disk at its own majority; the batch checksum names the group; one journal per process serves every group; answer-stage times are per group. *Evidence:* [E-02], [E-12], [E-29], [E-37], [E-48].

**O7. UNKNOWN. Answer stages and issue order across a move.**
- *Where:* DECISIONS V5-5 (O.seq, rule Y), V5-11 ruling 6; API.md:2240; LAYERS:117, :595, :635, 9.1; MEMORY 9.7 items 4 and 5; TRANSFORMS:208.
- *With many groups:* a burst to one partition that a fence cuts in two must still commit in order at B, so the O.seq state must move with the slot (H13). A write answered `received` at A, lost near A's fence and sent again to B, can meet a settings change that B has applied and A had not (S1). That turns an early answer into a refusal, against ruling 6. A record's outputs to one slot must keep their order across a target move (reasoned). [E-48] had no move (checked).
- *Settle by:* the `issue-order` model with a slot move and a forwarding hop (LAYERS 11 already owes it), plus answer stages with a settings change applied per group. **M**.

**O8. BREAKS (only for the later `memory` rung). The `memory` rung leans on a central table.**
- *Where:* MEMORY:55, :372 (rule 6), :379 (rule 13), :381 (rule 15), :387, :866; DECISIONS V5-5.
- *With many groups:* the slot table and group records sit in the home group. On a memory resource that group commits in memory, so a power cut can lose a table write, or an `open`, that another group already acted on: two groups then own one slot. Rule 15 names "the controller's tables", which no longer exist. "Comes back as it was a second earlier" holds per group; the resource comes back as a mix of earlier states (reasoned).
- *Needs:* a memory resource's home group commits on disk (or its table writes and opens wait for disk); rule 15 reads the home log; the user's sentence says "each part". 0 to +1 rule. Not in the first build. Model: [E-47] with moves and two failing groups. **M**.

### 2.3 Reads, positions and history

**P1. HOLDS. Positions are per slot and survive moves.**
- A version is the slot's (epoch, sequence), carried by a move; a cursor holds one entry per slot (4 to 13 KB at 4,096 slots, from the slot shape, not the group count); Merkle trees and hash chains were rejected with moves in mind. *Evidence:* [E-19], [E-31], [E-33], [E-56].

**P2. COST. A place over every row is a table, and a read waits for the slowest group.**
- *Where:* DECISIONS V5-12's review rules; LAYERS:705, 10 item 29; API.md:785, :1997 (`sync()`); TRANSFORMS:168-169.
- *With many groups:* a client keeps up to 4,096 entries per resource. `sync()`, `SYNC`, `PAGE` and a new picture wait until the store passes `seen` in every slot, so one slow group delays every answer (reasoned).

**P3. COST. Versions grow from 2 to 8 characters to about 10 to 14 once epochs rise with moves.**
- *Where:* CONNECT:186-190 (checked).

**P4. BREAKS. A link over a whole resource is "one SUB".**
- *Where:* LAYERS:686, :702-703, :726-727, :1116, :1549; PATHS:767; API.md:142, :611, :620, :636-638, :669-674; CONNECT:30, :87; PATTERNS:157, :183; TRANSFORMS:220; DECISIONS V5-13 pick 1.
- *With many groups:* the selection needs a SUB per group, or a relay that holds R0. Its picture comes in G parts at G positions, and its commits from G leaders (reasoned). Not written:
  - when `h.ready` is true;
  - what "the whole's server position" means for coverage and resume (it becomes a cut);
  - how a partition inside a held whole subscribes again;
  - what "now is the call" means for a root `changes()`.
  A `hold: 'all'` client must also run R1 and R2 in the client library, browser builds too.
- *Needs:* a whole selection is a SUB per group; it is ready when every group's picture has come; resume and coverage use the per-slot cut. +1 to +2 rules. Model: [E-31] with two slots in two groups, a move each and one group down (this also settles P5). **M**. Touches V5-13 pick 1, LAYERS 4.3.

**P5. UNKNOWN. What a read over every row does while one group is down.**
- *Where:* API.md:174, :579-584 ("sync reads never guess"), :620-621, section 8 (no code says that part is down); P-01, P-12, P-17; TRANSFORMS N-3 (:101), :168-169, :288, :370; LAYERS 4.2; PATTERNS:417; DECISIONS V5-13 pick 1, V5-14.
- *With many groups:* `hold: 'all'` opens, `connect().ready`, `f.data.get()`, served-view pictures, `SYNC`, page reads, a view's failover to a host that lacked the group, and `derive`'s takeover all wait for that group. Partition reads and writes elsewhere go on. The more groups, the likelier one is down, so whole-resource features get less available as the resource grows. No rule says wait, refuse, or answer for the live slots with a mark; an answer behind `seen` would break "never back in time". With one group, the same outage stopped everything (reasoned).
- *Settle by:* an owner decision (wait, with a health row naming the group; or a partial answer naming the missing slots), then E-57's B1 and group A with one group held down, and P4's model. A decision, then **M**.
- *Decided* (V5-18 pick 5): while one group is down, reads over every row wait, health names the group, and a sync read never guesses. **Changed for live merged views by V5-20 item 2**: the view keeps serving with that group's part frozen at its last place, health names the group, and a one-time fresh read waits. A group whose next slot-move half needs a half from the down group waits too, frozen at the same exact cut, and health names it; such a pair is never given up (V5-22 item 3). **The gap** (V5-22 item 4): the frozen part lives in the merger's memory, so a merger rebuilt while the group is down serves nothing new until the group is back. The view stays at the old merger's last frame and health says why. So "keeps serving" holds while the merger that holds the frozen part lives. A standby merger is studied later. Owed: the runs this item names, with the merger.

**P6. UNKNOWN. `-N`, a field's `-N`, a `Date` and a version, read back across a move.**
- *Where:* LAYERS:274, :731, :769-770; CONNECT:88, :217, :225-227; ANYPATH:31, :198; API.md:676-688, :958; DECISIONS V5-13 pick 4, V5-15 pick 2.
- *With many groups:* counting back past a fence reads the old group's segments, which the carried set names. They may sit on other machines, in the object store, or be gone if that group kept less `history` or was dropped. A `Date` search assumes sorted times, which O3 breaks (reasoned).
- *Settle by:* E-62's countback bench (in progress) with a move in the partition's history and the old segments remote or in the store. **S**.

**P7. UNKNOWN. `past(pos)` before a move, and the record form's restart from a share's past.**
- *Where:* LAYERS:1066, :1068, :1428; CONNECT:89; TRANSFORMS:209, :372; ANYPATH:31; PATTERNS:399, :408; API.md:883-906, :961.
- *With many groups:* snapshots are per group. A place before a move needs the old group's snapshot (which holds many other slots) plus its segments, and the carried set names segments, not snapshots. A deriver's share spans many source groups, so its restart opens a past per slot across groups (reasoned).
- *Settle by:* E-31's log reader with a `past` open below a fence, and a priced fetch of the old group's snapshot. Likely +0 to +1 rule (carry the snapshot names). **M**.

**P8. UNKNOWN. A restore, fork or tape of one resource is a cut across groups.**
- *Where:* DECISIONS V5-1, V5-4's consequences; LAYERS:237, :1353, :1364, :1380, :1397; API.md:2102 (P-18), :2329; AMENDMENTS K-13, K-14.
- *With many groups:* one resource's restore at a time T is a cut, one position per slot, as V5-4 already says across resources, and a saga can be half inside it. A restore to before a move needs the old table and the old group's segments. How the home group is rebuilt beside many data groups is not modelled, nor a fork while a slot moves (reasoned).
- *Settle by:* [E-33] with two groups, a move after the backup and a dropped group; and a sentence that a resource's restore is a cut. **M**.

**P9. UNKNOWN. Keeping old segments across groups, dropped groups, and shrinking.**
- *Where:* LAYERS:255 (`tier`), :364 rules 5-6, :1366; DESIGN-V5 4.2; SIMPLICITY (`move-policy`); REQUIREMENTS SC-04.
- *With many groups:* a segment of A holds many slots. Slots that moved out still name it, so A cannot drop it while any target names it, and a dropped group's segments must outlive the group. A fold-version or tier change must follow names across groups (reasoned). Shrinking never ran: [E-18] only grows (checked).
- *Settle by:* a model of `tier` across groups with moves and a drop, then SC-04's daily-cycle simulation. **M** to **L**.

**P10. HOLDS. Reads, links and patterns inside one partition.**
- A partition sits in one group at a time; a move ends its SUB at the fence and the reader subscribes again at B from the same position; `lookup` opens one link per key; consumers keep order within a partition; a forwarding server forwards to the right leader; a call on a path follows one `moved`; patterns scoped to a partition stay up while another group is down. *Evidence:* [E-22], [E-30], [E-31] (ten bounds with a move), [E-58].

**P11. COST. `f.cluster` has one `writable`, one `lag` and one `caughtUp`.**
- *Where:* API.md:525, :659, :2009-2038 (`ClusterShape`); DECISIONS V5-16 picks 1 and 4; LAYERS:856.
- *With many groups:* a resource can be writable in some slots and not in others, lag is per group, and every move, new group and hand-back makes a new shape. `writable` needs a definition (every group has a leader and the gate is open), each entry of `groups` needs its own, and shape changes need pacing; V5-16 already owes "how often `lag` counts as a change" (reasoned).

### 2.4 Served views and `derive`

**V1. BREAKS. A served view lives "on one copy, chosen by a hash over every copy but the leader".**
- *Where:* DECISIONS V5-14 pick 3 (and REJECTED: standbys first); TRANSFORMS:32, :272, :309, :371, :543, :557; API.md:126, :615, :707, :713, :779, :784, :811, :953-954, :1153, P-12, question 32; LAYERS:76, :190, :450, :614, :691, :709-711, :743, :751, :771, :1117, 8.11, 10 item 40.
- *With many groups:* no copy of one group holds every row, so the host needs R0, and "the leader" has no single meaning. If leaders spread, as SC-03 needs (H7), most servers lead some group. Then "never on a leader" leaves no host, or puts view builds of 0.49 to 1.9 s at 1e6 rows (measured, XA-1 in [E-57]) on a process that judges writes, which pick 3 was chosen to stop (reasoned). This already happens across resources, since a copy of one resource leads groups of others on the same main thread (reasoned). Every placement number (XA-1, XA-2, the hand-off counts) ran with one group (checked: E-57 README:200).
- *Needs:* restate pick 3: a hash over the servers that hold, or can hold, R0 for the resource, preferring those that lead no group of it. Say that stalls can reach writers until `data` builds in slices (N9, D9). +1 rule. Rerun XA-1, XA-2 and A3 at G = 4 and 16 (R1). Touches V5-14 pick 3, API.md question 32.
- *Decided* (V5-20 item 13, which changes V5-14 pick 3; question 6): a served view lives on any server that holds its rows, preferring one that leads no group of its resource; until `data` builds views in slices, a build can stall a leader's writes. Serving only on servers that lead nothing is rejected. Over several groups the view is merged: each group's partial lives on a copy of that group by the same rule, and the merger on one server (V5-20 item 1; MERGE 5.2). The reruns are still owed.

**V2. UNKNOWN. The cap of 64 per copy, the headroom `views.max / k`, hand-offs and refusals.**
- *Where:* DECISIONS V5-14 pick 2; TRANSFORMS:272, :302-304, :384, :463, :557; API.md:780-782, :1152, :2389, :2482-2483.
- *With many groups:* a server with three groups of one resource has one R0 store and one budget. So the cap is per server per resource, and k is the size of the serving set, which changes as groups come and go. Under any "off the leaders" rule, every leader change of any group can move views, and adding a group or a server moves about 1/k of them (reasoned). XA-2's 5 to 21 refusals in 1,000 seeds came from one group's churn (measured, E-57).
- *Settle by:* restate "copy" as "server" for the cap and for k; rerun XA-2, XA-9 and A3 with groups and hand-backs (inside R1). **L**.

**V3. UNKNOWN. `{ pages }` across a move, a new group and a group down.**
- *Where:* DECISIONS V5-14 pick 4 and its owed "paging across a failover"; API.md:788, :955, :1998-2002.
- *With many groups:* the index is R0 on one host; "exact within one cut" means a cut across groups; a page walk can meet a move or a down group (reasoned).
- *Settle by:* add "across a move, and with one group down" to the owed paging run. **M**.
- *Decided, in part* (V5-20 item 11): over several groups each group keeps its own index, and a page read asks every group in one round; a two-round form comes once a pinned read exists. The paging run is still owed.

**V4. COST. Served views get more, smaller frames, and the row guards bite more often.**
- *Where:* TRANSFORMS:283, :289; CONNECT:176; API.md:783, :2413.
- *With many groups:* G streams of batches give more frames, encodes and sink calls a second for the same writes, and a ring of 64 frames covers less time, so more resumes take a picture. Big resources get no ordered view over 5,000 rows and no pages over 2,000 until D8c (reasoned; the guards are V5-14 pick 1).

**V5. UNKNOWN. `derive`'s view form over a source with many groups, and with a target group down.**
- *Where:* DECISIONS V5-14 pick 5; TRANSFORMS:198-205, :372, 10 item 9; PATTERNS:392-393, :409, :417, :420; API.md:818, :820, :843-849, :962, P-17; LAYERS 8.8.
- *With many groups:* the deriver holds and folds the whole source (R0). Its read barrier is a cut read from every source group, so a source group that is down blocks every takeover, and the target trails the slowest source group rather than "about one commit". One target group down blocks the bump, and then the whole target stops following (reasoned). B3's source had one group, and B1 had no deriver (checked: TRANSFORMS 10 item 9).
- *Settle by:* B3 on B1's store at G = 4, with source moves, a source group down and a target group down. **M** to **L**.
- *Decided, in part* (V5-20 item 10): over several groups the deriver follows the merged view, holding the buckets, never the source rows (MERGE 5.2), so it no longer holds R0. Its buckets have a stated limit, about 1.6e5 at 16 groups; past it, the record form, and O4 (shards by output key) comes next. A source group that is down freezes its part of the merged view (P5). The run is still owed.

**V6. BREAKS (reasoned from the written rules). "A bump at every target group" misses a group made during a takeover.**
- *Where:* DECISIONS V5-14 pick 5; TRANSFORMS:200; PATTERNS:392; LAYERS:1058, :1114 (the wire: "one per target group"), :1366, :1446, 10 item 41; API.md:845, :2373.
- *With many groups:* the deriver reads the target's groups, then bumps each. Say a new target group is made after that read, and a slot moves into it from g1 before g1's bump. The new group never gets the bump, and an old deriver's late write to that slot passes the fence. Moves between groups that already exist are covered, since a move carries the fence table "merged by max". Also, the wire has no `ASK` addressed to a group: a write routes by path, and a path's slot can move during the bump.
- *Needs:* after the bumps, read the target's groups again and bump any new one (or bump per slot), and give the bump a form addressed to a group. +1 rule. Confirm inside V5's run with a target split during a takeover. Touches V5-14 pick 5.

**V7. UNKNOWN. The record form's marks with many target groups.**
- *Where:* DECISIONS V5-2 point 4; LAYERS:528, :607; TRANSFORMS:208; PATTERNS:398, :400; API.md:857, :1388.
- *With many groups:* `marks(name)` reads every target group (G reads). With one target group down it cannot be worked out safely, so a restart waits. A bare mark must raise every output slot's mark: a write to each such group, per idle record or per period, which is not written (reasoned). Correctness held in [E-30] with two output groups and an output move (checked).
- *A side cost, not from groups:* the mark table per (source slot, output slot) can reach 4,096 × 4,096 × 29 B, about 490 MB per reader, when outputs are keyed apart from inputs (arithmetic). It comes from the slot shape, exists with one group too, and is unpriced.
- *Settle by:* E-61 (in progress), a restart rule with a target group down, a bare-mark rule, and a priced mark table. **S** to **M**.
- *Decided, in part* (V5-20 items 16 to 19, from [E-61]): a deriver joins each output slot in `#groups` before its first write there; `marks()` reads only the joined slots, and bare marks go only to them, so a deriver that writes one slot sends no bare marks to the other 4,095 (item 19). E-61 checked the marks written by app code on 42 bounds and 4,000 seeded runs. Still owed: the restart with a target group down, and a priced mark table.

**V8. UNKNOWN. A `data` upgrade switches at a different place in each group.**
- *Where:* TRANSFORMS:376, :389, 10 item 18; LAYERS:529, :549, :1598; DECISIONS V5-14's owed "a data upgrade under live views"; AMENDMENTS (a fold-version entry in each group's log).
- *With many groups:* an R0 store folds slots of switched and unswitched groups at once. A served entry's key holds "the data build", which has no one value until the last group switches. A deriver has G switch points. A slot whose history spans a move has stretches cut at two switch points (reasoned). [E-43] found that two builds can fold rows differently, not only views (checked).
- *Settle by:* a rule (switch per group and rebuild whole-resource views once, at the last switch; or one switch for the resource, ordered through the home log), then XA-10's rolling deploy and B1 with a fold-version change in one group at G = 4. **M**.

**V9. HOLDS. The merge contract, and a store fed by slot, stay exact through moves.**
- *Evidence:* E-57 B1: 19,167,410 checks at G = 1, 4, 16 and changing, through 6,122 moves, 0 mismatches; with R1 or R2 off, 685 to 990 of 1,000 seeds fail (checked, [E-57]); [E-23]. *Limits:* one process, 1,024 slots, no epochs, every group reachable (G4, P5), one move at a time, and no `abort` path, so an aborted import's R2 copy is unchecked (checked: E-57's b-merge README).

**V10. HOLDS. Marks, sessions and fence tables move with a slot (the parts modelled), and the record form goes on with live groups.**
- *Evidence:* [E-20] (exactly once with a move during a retry), [E-30] (marks per output slot; the per-group form lost an output), [E-32] (dedup state carried), [E-15], [E-17c]. A source group that is down stops only its own slots (LAYERS:1463). A source slot move in the record form holds by reasoning, since marks are per source slot.

### 2.5 Methods, consumers, queues, locks, sagas and sessions

**Q1. BREAKS. A handler's writes commit "at this same leader".**
- *Where:* PATTERNS:116; DECISIONS V5-16 pick 3.
- *With many groups:* a row handler that reads or writes other rows reaches other groups, often on other servers. Each read is a trip or needs R0. Each write goes to another leader, can get `moved`, and the reply waits for commits elsewhere. Its writes to two groups are not ordered together. With one group, every partition shared one leader (reasoned).
- *Needs (an owner pick):* say "at the leader of each partition it writes", with the trips and no order across groups; or allow a row handler to write only its own partition. 0 rules.

**Q2. UNKNOWN. A call that meets a slot move halfway.**
- *Where:* DECISIONS V5-12 picks 3 and 13; API.md question 29.
- *With many groups:* a handler running at A whose writes meet A's fence gets `retry` or `moved`. Is the call failed, or run again at B, with its side effects twice unless it is a `once` call? This is clear for a plain write, not for a half-run handler (reasoned).
- *Settle by:* a decision, then a model of a call that meets a move on [E-20]'s engine. **S**.

**Q3. COST. One write line per client mixes healthy and stuck groups.**
- *Where:* API.md:141, :389-393, :863, :930, :2241, :2388; PATTERNS:190; LAYERS 4.2, 8.8 step 7.
- *With many groups:* writes to a group with no leader fill the 512 waiting writes or 64 MB, and then writes to healthy groups are refused `backpressure` too. A marked write waits and pauses its reader, so a deriver whose outputs touch the down group stops for every output (reasoned). A line per group costs +0 to +1 rule.

**Q4. UNKNOWN. Credits with many leaders.**
- *Where:* LAYERS:699, :719 (`admission-credits`); MEMORY 9.3; AMENDMENTS G-19, K-18.
- *With many groups:* with direct routing a client writes to several leaders on several servers. Each grants credits on its own, so nobody bounds the client's total (reasoned).
- *Settle by:* K-18's model: credits with forwarding, failover and moves. **M**.

**Q5. COST. Consumer shares are sets of slots spread over every group.**
- *Where:* LAYERS:1049, :1054, 8.8 step 3; PATTERNS:185; API.md:853, :855, :963, P-08, question 37; PATHS 4.14.
- *With many groups:* each member reads its share from every group (G links, a cursor per slot) and subscribes again at each move, and one group down stalls part of every share (reasoned). PATHS 4.14's case of a share made of whole groups goes. Shares do not move with slots, which is good (checked: LAYERS:1049).

**Q6. COST. A queue keeps its order; many groups add nothing to one queue partition.**
- *Where:* PATTERNS:239, :246; API.md:2121-2128, P-09, P-22, question 39.
- *With many groups:* a queue in one partition gets one leader's rate. A hot queue makes its slot hot, and moving that slot moves the whole queue, with a window each time. A `take()` across partitions tries partitions in several groups, and the lapsed-lease poll touches each (reasoned).

**Q7. UNKNOWN. Lock fence tables grow by union with each move.**
- *Where:* PATTERNS:287, :307; LAYERS:525, 8.6 step 4; DESIGN-V5 4.2; AMENDMENTS K-16.
- *With many groups:* a move merges the source's whole fence table, every lock name and not only those used on the slot, into the target, so tables grow by union. When an entry may go is open (reasoned).
- *Settle by:* price the table after N moves with L locks, and write a rule for dropping entries. **S**.

**Q8. UNKNOWN. Sagas with moves, and the sweep over `#sagas`'s groups.**
- *Where:* PATTERNS:324, :340, :354; [E-24]'s README; AMENDMENTS K-02.
- *With many groups:* E-24's saga world has no move, and [E-32] carried "the highest token", not a fence table (checked). The carry "merged by max" should refuse a paused holder's stale step in a new group, but no model ran it. The sweep scans `#sagas` over every group, and a down group hides its intents (reasoned).
- *Settle by:* E-24's saga model with a partition moved mid-saga and a move into a new group. **M**.

**Q9. UNKNOWN. System resources and project-wide state at scale.**
- *Where:* API.md:2232, :2244, :2312-2313 (`revoke`), :2487, P-13, question Q-B3; LAYERS:211, :452, :466, :550, :1702-1703, 10 items 5 and 17; PATHS:920, :922.
- *With many groups:* if `#sessions`, `#calls` and `#locks` have one group each, one leader takes every session renewal of the project. At 1e6 clients renewing every few seconds that is far above 50,000 a second (arithmetic, with a guessed period), and every server holds all of them: 309 B a client (measured, [E-20]), about 295 MB at 1e6. So they need many groups themselves, and every process that leads any group then follows a many-group `#sessions`, which is an R0 follow. A lapse removes rows in every group that holds them, at different times. A `revoke` must reach every leader and copy, and where the revoked list lives is open (reasoned).
- *Settle by:* the renewal rate per leader at the target client count, a decision on system resources with many groups, and a measure of the `#sessions` follow per leading process. **M**.

**Q10. UNKNOWN. `ask()` "looks for a live answerer".**
- *Where:* PATTERNS:120; [E-22]'s API notes.
- *With many groups:* if presence rows spread over partitions, "is any answerer live?" is a read over many groups, and a down group can hide the only answerer, so the ask fails `no-answerer` by mistake (reasoned).
- *Settle by:* put presence rows in one partition, or say what the read is. **S** (a decision).

**Q11. UNKNOWN. P-04: "one `load` per key however many readers miss".**
- *Where:* API.md:2586-2590.
- *With many groups:* a load started at the old leader and a miss at the new one across a move can make two loads. The `if: { absent }` write keeps the state right; only "one load" is at risk (reasoned).
- *Settle by:* an E-22 seed aimed at a move during a load. **S**.

**Q12. HOLDS. Pieces already written for many groups.**
- The root action's "+1 trip per write its server does not lead: 0.66 with 3 servers, 0.80 with 5" is already a figure for spread leaders; `#calls`'s claim is one partition; a new `#locks` leader extends only its own group's leases; `ping.ms` per machine pair, `handback.max`, `bulk.rate` and the CLI's `move`, `groups` and `place` are written per group. *Evidence:* [E-45]; [E-55] claim 18 (a stand-in).

**Q13. COST. `fero.drop` and a clean stop across many groups.**
- *Where:* API.md:300, :2100, :2328; LAYERS 8.9 (`leave.ms` 4 s).
- *With many groups:* a drop reaches every group, every copy and the home records, and is half done while one group is down. A clean stop is a heal of every group the server held, paced by the caps, so it cannot finish in 4 s for large data and exits with groups on two of three copies (reasoned). E-59 (in progress) models the clean stop per group.

**Q14. UNKNOWN. `rows.max` "kept per group as its share".**
- *Where:* API.md:2319, P-02.
- *With many groups:* the share when groups hold unequal numbers of slots, and what a move does to two groups' shares, are not said (checked: API.md:2319 says only "kept per group as its share, rounded up").
- *Settle by:* a rule, for example a share by slot count, worked out again at each `open`. **S**.

### 2.6 The home group, placement, growth and slot moves

**H1. BREAKS. The home group is the only place a client learns the layout.**
- *Where:* DECISIONS V5-3 ("learns the members, slot table and leaders from the resource itself"), V5-10 fixes 2 to 4; LAYERS:95, :398, :437 (`route-forward`), :449-451, :856, 8.3, 8.4 (":1301": g2 "still takes writes"), 10 item 22; API.md:171-174.
- *With many groups:* the directory lists any copy, and only a group's leader follows the home log, so a client often lands on a follower of g2 with no home records (checked: LAYERS 2.3's notes on the soft directory, and 10 item 22). While the home group has no majority, linked clients keep writing. But a new client, or one whose route went stale after a move, cannot learn the table or the leaders, so live groups are out of its reach. A forwarding server needs the home records of every resource it forwards for (reasoned).
- *Needs:* every copy of every group keeps the home records (it follows them, or its leader passes them down in the group's own log) and hands out its last known table and leaders, maybe stale, corrected by `moved`. LAYERS 10 item 22 already reads this way and leaves "how a follower learns them" open. +1 to +2 rules. Model: [E-51]'s client model with two groups on different machines, the home group down, and a client that first reaches the other group (already owed in LAYERS 11). **M**. Touches V5-3.

**H2. UNKNOWN. A group record's leader is a hint, with no rule to keep it fresh.**
- *Where:* LAYERS:324, :364 rule 1, :450.
- *With many groups:* clients learn other groups' leaders only from these hints, and leaders change at every election, handover and hand-back. Either each change is written to the home log, whose load then grows with elections across all groups, or hints go stale and direct routing pays redirects (reasoned).
- *Settle by:* a rule, and a measure of redirects after a roll at G = 16. **S** to **M**.

**H3. UNKNOWN. One incarnation in the cursor and the resource check, while incarnations are per group.**
- *Where:* LAYERS:364 rules 2-3, :369, :697 (the cursor), :1109 (the resource check), 10 item 11.
- *With many groups:* an operator recovery of g2 must reach g2's old followers, which do not follow the home log. A client or copy talking to g2 needs g2's incarnation. A cursor that holds "the resource's incarnation" cannot refuse only the slots g2 held (reasoned).
- *Settle by:* a format decision (an incarnation per group or per slot in the cursor, or a recovery raises the epochs of the group's slots), then E-51's incarnation model with followers that do not read the home log, and E-31 with a group recovery. **S** to **M**.

**H4. BREAKS. The home group down during a move leaves the slot unwritable for the whole outage.**
- *Where:* LAYERS 8.6 steps 5-6 and "What waits" ("neither outage stops them"); [E-15]'s README (`#meta` "never fails"); AMENDMENTS K-07, K-27.
- *With many groups:* once A's fence commits, the slot can reopen only at B, after its table row is in the home log, or back at A, after an abort that first writes the row back to A (checked: LAYERS 8.6). Both need the home group. If it loses its majority in that gap, the slot takes no writes at A or at B until it returns. So one group's fault blocks a partition that lives in two others, and SC-08(b) fails under one fault (reasoned). LAYERS' sentence holds only for an outage that starts before the fence. Every move model kept the table in `#meta`, which never failed (checked: E-15).
- *Needs:* B may give up without a home write when it never wrote the table row (the abort writes back only a row it wrote), on a timer, so A reopens; or the move writes "pending to B" before the fence. 0 to +1 rule. Model: inside H12's family. Touches A-17 point 4.

**H5. COST. The home group is a controller for its resource.**
- *Where:* DECISIONS V5-2 point 3 and its REJECTED ground ([E-16]); SIMPLICITY:296; LAYERS:429, :1363, :1374, 10 item 10; VERDICT:1257.
- *With many groups:* healing stays per group, with nothing shared. But moves, new groups, shrinks, settings changes, group-record rewrites and the removal of a copy's data are decided or written through the home group, and none of them runs while it has no majority. That is `#meta`'s shape per resource, which E-16 judged for healing only. The scope is one resource and nothing unsafe follows; the pages should list what waits (reasoned).

**H6. BREAKS. A new group starts with one voter, and the move policy can fill it at once.**
- *Where:* LAYERS:119, :318, :380, :412, :425, 8.6 ("A new group"), 10 items 10 and 20; API.md:185, :267, :2475, questions Q-A25 and 32; DECISIONS V5-5.
- *With many groups:* a new empty group is the least loaded, so `move-policy` sends it slots while it still has one voter (checked: LAYERS 2.3, `move-policy` has no voter test). Rows and writes there commit on one disk, below `copies`, and losing that disk loses answered writes (F-01) (reasoned). While a group has one voter, V5-14 pick 3 has no copy to place views on (checked: LAYERS 10 item 40).
- *Needs:* no slot opens in a group with fewer voters than `copies` (or a new group is placed with three voters before any move). +1 rule. Model: E-59 (in progress) with a move into a growing group. **S** to **M**. Touches V5-5, A-18, LAYERS 2.3.

**H7. BREAKS (reasoned). A new group's leader and preferred member stay on the home leader's machine.**
- *Where:* LAYERS:318, 2.3 (`handback` rules 5-6), 8.6 ("A new group"); DECISIONS V5-10 fix 7, V5-2's consequences.
- *With many groups:* the creator founds the new group as its first voter (checked: LAYERS 8.6), and the stored placement names it first. Read plainly, it stays the preferred member until it leaves the placement (`handback` rule 5), and the hand-back keeps bringing leadership back to it. So the home leader's machine leads every group the resource grows, and a split does not spread writes (SC-03) (reasoned; no record says how a new group's preferred member is set).
- *Needs:* a new group's placement is picked by load and memory, with its preferred member on another machine than the busy group's leader. 0 to +1 rule (a policy). Once leaders spread, V1 applies. Touches V5-2's consequences, V5-10 fix 7.

**H8. UNKNOWN. Placement by load with many groups of one resource.**
- *Where:* DECISIONS V5-2's consequences ("reasoned, not modelled"); LAYERS:406, :410, section 11; [E-52]'s README.
- *With many groups:* nothing spreads one resource's groups over machines, and "load" is not defined (writes, memory or disk). After a machine is lost, every group it held picks among the same quiet machines, and the snapshot installs queue behind one byte-rate cap. A resource bigger than one server needs its groups on different servers by memory (reasoned).
- *Settle by:* E-52's world with three or more groups of one resource, one machine lost, and placement by load and memory, with E-52's two-choice pick. **M** to **L**.

**H9. BREAKS. No rule says when a resource gets a new group, and nothing grows it by size.**
- *Where:* DECISIONS V5-2 points 1-3, V5-10 fix 5; AMENDMENTS A-18; LAYERS:425, 8.6, 10 item 10; DESIGN-V5 4.2 (:511: `shard.bytes`, `shard.rate`); [E-49]'s README; REQUIREMENTS SC-03, SC-04, SC-06.
- *With many groups:* A-18's policy moves slots between groups that exist and shrinks quiet ones. DESIGN-V5's grow rule (over 4 GB, or half the leader's rate) is not in LAYERS' counted records, so no counted rule adds a group (checked: LAYERS 10 item 10 reads it, uncounted). Every resource starts as one group with all 4,096 slots, so a seed, an import or a restore bigger than one server cannot land: the home group's copies must hold everything before any move (reasoned).
- *Needs:* a counted grow rule, by size and by load, and a pre-split at founding, import and restore from a size hint (start with G groups). Founding today makes the home group only (checked: LAYERS 2.3 founding rule 4; [E-51]), so a pre-split changes founding too. +1 to +2 rules. Model: [E-18] with size, the trigger and time. **M**. Touches V5-2 point 3, A-18.

**H10. UNKNOWN. How long growth takes, and how much it copies.**
- *Where:* AMENDMENTS K-25; [E-18]'s README; LAYERS:237, :425, :429, :1363, :1375; PATHS:51, :1110, :1121, PA-15; DECISIONS V5-9 (PA-15 deferred).
- *With many groups:*
  - Growing from 1 to 64 groups takes about 13,200 one-slot moves at 4,096 slots and copies 3.4 to 3.8 times the rows, one move at a time per resource (measured in E-18's model).
  - Each move is three commits (E-13's chain already had the table row in another group), a restore-mark PUT (1.4 ms at the median and 2.7 to 4.3 ms at p99 on MinIO here, measured, [E-28]), a copy sent and folded three times under the byte-rate cap, and a carry of every client's floor (16 MB a move at 1e6 clients, K-25).
  - A busy group stays overloaded 1.4 to 3.3 times meanwhile (E-18), and a store outage stops all growth (checked: LAYERS 8.6 "What waits").
  - A move by reference saves nothing when the target's copies sit on other machines, which is why moves exist (reasoned).
- *Settle by:* a timed growth from 1 to 16 groups under steady load on three or more processes, in virtual time first and then real, against an owner target for growth time. **L** (needs a working move).

**H11. BREAKS. The only modelled move misses SC-08(b), and its real window is not known.**
- *Where:* AMENDMENTS A-17 (3), K-03, K-25, G-28; LAYERS 8.6 ("The unwritable window"), 10 item 12; PATHS 3.9 (:606), PA-20 (:1344); [E-13]; DECISIONS V5-9 (PA-20 deferred).
- *With many groups:* moves become routine, and SC-08(b) asks for at most 10 ms per move.
  - E-13 timed the three-commit chain at 16.7 ms at p99 under 10,000 writes a second (measured). Its chain had the fence, the table row and the open in three groups on three processes, so it already is the home-log form with a target that is not home. The home-log table adds no commit to it (checked: E-13's method).
  - At that load one commit took 4.56 ms at p99 and two took 12.77 ms (measured). So only a one-commit window meets 10 ms there.
  - E-13 moved no bytes (checked: A-17, G-28). LAYERS 8.6 step 3 sends the delta, `END(N)` and the carried set after the fence commits, so they sit inside the window. K-25 puts the carried set at 16 MB a move at 1e6 clients: about 16 ms at 1 GB/s on its own (arithmetic).
  - All three members fsynced on one disk; independent disks cut p99 about in half (checked: E-13).
  - So the window is unknown in both directions. Writes caught in a move also back off at least 200 ms as drafted (checked: PA-20).
- *Needs:* model and take a cut form, starting from E-17b's fused core (the fence is the decision; the final copy opens the slot), with the table in the home log. Add a rule that sends the carried set before the fence, so only a small delta crosses the window. Time the window with a real carried set, on independent disks, at 2,000 and 10,000 writes a second. Or restate SC-08(b): E-13 proposes a p50 bar plus a p99 bar tied to load. Take PA-20's short retry-after.
- *Rules:* the fused core is 3 to 5 rules fewer than the drafted move (checked: [E-17b], [E-17c], crash-only); the speed layer it needs back (announce, bulk copy, ready) and the carried-set rule add some back. About −4 to +1 (a guess). Touches A-17 (3), V5-9 (PA-20), LAYERS 10 item 12.

**H12. UNKNOWN. The move's evidence is thin, and comes from `#meta`'s world.**
- *Where:* LAYERS:424 (`slot-move`: 39 % of mutants caught, G-07), :430, 8.6, 10 item 10, section 11; SIMPLICITY:55, :232-235, :296; [E-17c]'s README.
- *With many groups:* E-15, E-17c and E-32 kept the table in `#meta`, with at most three groups. E-51's records model moves a slot to the home group and back, as records only. "Move s" and `ready` have no message. A move meeting a membership change at two faults is open (K-01) (checked: LAYERS 11).
  - E-15's 39 % against an 85 % bar comes mostly from spare guards: only 31 of its 138 guards and updates are rules (checked: [E-15]).
  - LAYERS 8.6 says "nobody has modelled a cut form", but E-17b's fused probe is one, crash-only: 24 rules (25 in a real log), and it caught 34 of the 34 mutants that change anything (checked: [E-17b], [E-17c]). It has no bulk copy and no table in a home log.
- *Settle by:* one model family that also settles H4 and H11: start from the fused core, put the table in the home log, take the home group down, add the carried set, lost or late messages, K-01's two faults, and mutants to the 85 % bar, which a small spec can reach. **L**.

**H13. BREAKS. The move's carried set misses state the design needs after a move.**
- *Where:* AMENDMENTS A-17 (2); LAYERS:522, :527, :546, :635, :1366, 10 items 19 and 33; API.md:2245-2250, :2390; [E-20]'s README; G-12.
- *With many groups:* A-17 names the slot's sequence and epoch, session outcomes and floors, the fence table, source marks and segment names (checked). It misses:
  - the caller-key table, so a `once` retry after a move runs the handler again (LAYERS 10 item 19 says so);
  - the O.seq state, so B cannot refuse a gap (O7);
  - the slot's last stamp (O3);
  - the row-version store, if it lives beside the rows, so `if: { version }` and lock tokens meet a missing version;
  - tombstones, so a cheap resume across a move becomes a full picture;
  - snapshot names (P7).
  The bound of 1e6 live `once` names per resource also needs a share per group (reasoned).
- *Needs:* name each in A-17's set, and say whether copied records keep their versions. 0 to +2 rules (mostly data to carry). Model: E-32's composed model again with the full set, and G-12. **M**. Touches A-17.

**H14. UNKNOWN. One byte-rate cap and two snapshot loads per member, shared by every group.**
- *Where:* DECISIONS V5-9 (3); LAYERS:253, :411, :1303.
- *With many groups:* a lost machine starts a heal in every group it held, and a split starts many moves, all under one link cap, one disk cap and two snapshot loads per member. If the cap also paces a move's fenced part (the delta, `END(N)`, the carried set), the window grows past SC-08(b) (reasoned; H11 has the carried set's size).
- *Settle by:* a rule that the fenced part skips the cap, and a timed run of a heal beside a move. **S** to **M**.

**H15. UNKNOWN. Many groups failing over at once, and a resource partly up.**
- *Where:* REQUIREMENTS F-19; LAYERS:479, :497, :1333; AMENDMENTS K-22, G-30.
- *With many groups:* a dead server stops writes to about a third of each resource's groups for 2 to 2.5 s while the others go on (reasoned). Thousands of elections at once are not timed in TypeScript, and no run had quiet groups find a loss by link pings (checked: K-22, G-30).
- *Settle by:* kill a server that leads a third of 1,000 groups, with quiet groups, on [E-10]'s port; and hold one group of a resource down while clients use the rest. **M**.

**H16. HOLDS. Raft, routing and the per-member pieces are already per group.**
- Raft runs per group, with learners, PreVote, transfer and ReadIndex. Routing goes by the path's first key, with `moved` and `retry`. Forks write one record per group. A protocol version rises once every copy of every group can speak it. Quiet groups and the hand-back cap count per member. Group records and the home group's recovery window held with a home group and a data group; healing per group needs no rule for more groups. *Evidence:* [E-10], [E-14], [E-14b], [E-14c], [E-38], [E-46], [E-51], [E-52], [E-53]. *Limit:* founding makes the home group only ([E-51]), so a pre-split is new (H9).

### 2.7 Settings

**S1. BREAKS. A settings change takes effect in each group at its own time.**
- *Where:* DECISIONS V5-2 point 2, V5-10 fix 3; API.md:198 ("the resource's own log, so every copy and client agrees"), :486, :1015, :1339, :2467, :2481, P-20; LAYERS 2.3 (`meta-catalog`: "While the gate is read-only, every group refuses every write"), :449, :873; [E-51]'s catalog model.
- *With many groups:* the record is in the home log. Other groups' leaders follow it and apply it at their own entry, after a lag. In that window groups judge writes under different `validation`, `rules`, `schema`, `methods`, `shape`, `views.*` or timing keys, and some groups still take writes after the read-only gate is set (reasoned). E-51's GATE property is itself per group: "no write commits in a group that has applied the read-only gate" (checked), so the window is real. P-20's "from which position each `shape.version` is in force" needs a position per group. "Every copy and client agrees" holds only in the end.
- *Needs:* each group records the entry at which it adopted a settings version (beside fix 3's record rewrite); `fero.alter` answers only once every group has adopted it, which the gate needs; P-20 names a position per group. +1 rule. Model: E-51's catalog with two data groups and an `alter`. **S**. Touches V5-2 point 2, V5-10 fix 3, P-20.

### 2.8 Costs and rule counts

**X1. COST. "Per resource" figures are per group.**
- *Where:* DECISIONS V5-2's consequences (1.4 KB), V5-7 (3 to 5 s boot at 1,000 resources per process), V5-8 (8 KB resident, 2.5 KB dormant); VERDICT:1267; API.md:177, :189, :2320; LAYERS:228, :293, :461-471, :477, :481, :1334, 10 item 15; PATHS:1282, :1290; [E-49]; [E-53].
- *With many groups:* a resource with G groups costs, on each member that holds them, about G × 3.1 to 3.9 KB of Raft state, G × 12 KB and 3 inodes of files, and G × 169 B of records (reasoned from E-49's per-group parts). The knee of about 10,000 groups per process, F-05's margin at cap 8, the GC pause figures and DEP-13's 100 MB point then come at 1/G as many resources. A woken resource is writable everywhere only when every group has elected. Hand-back time grows with groups per member. Each figure needs restating per group plus per resource.

**X2. COST. The slot table breaks into many runs.**
- *Where:* LAYERS:323, :450, :468; [E-36]; [E-49].
- *With many groups:* single-slot moves break the run-length table toward 4,096 runs (about +40 B a run, up to about 160 KB), held by every member and sent in every client's first download. A big resource touches every slot, so per-slot state heads to E-49's dense 120 KB (reasoned from E-36 and E-49).

**X3. COST. Writes spread thin cost more.**
- *Where:* LAYERS:473; API.md:386, :930.
- *With many groups:* a resource's writes split into smaller batches per group, and a frame per leader carries fewer records. In [E-11], spreading the same 10,000 writes a second over 16 groups cost 49 % of a core per process in TypeScript, and over 10,000 groups 72 %, with p99 from 10 to 121 ms (measured). A split pays only when one leader is the bottleneck (reasoned).

**X4. COST. Links and forwarding grow.**
- *Where:* LAYERS:258, :272, :437, 8.3; PATHS:448, PA-4 (:1328), PA-27 (:1351); DECISIONS V5-9 (1).
- *With many groups:* once every machine pair shares some group, links and idle pings grow as N². A direct client opens a link to every server that leads a group it writes to, each with a handshake and a leader learned from hints. A one-link client's server leads about 1 group in N, adds a hop on (N − 1)/N of writes, and seldom folds the group, so the `ANSWER` is needed (reasoned).

**X5. COST. PATHS and the walk-throughs price only the case where every server holds every group.**
- *Where:* PATHS 1.1 (:67), :761, :1110; LAYERS 0.4, 8.1, 8.3, 8.6; PA-15, PA-19, PA-27.
- *With many groups:* "1.2 to 1.5 times the least work" is for that case only (checked: PATHS:67 has every server hold and fold every group). The paths that matter for a big resource (a read over every row on a server that lacks groups, a write whose leader is elsewhere, growth, a move between machines) were not stepped. Owed: walk-throughs with five or more servers and more than two groups.

**X6. COST. The rule counts are one-group counts.**
- *Where:* DECISIONS V5-6, V5-9, V5-10 (416), V5-12 (+12 to +18), V5-14 (+26); LAYERS 0.2 (:114: R0 to R2 "outside the first build"), 2.3 (`slot-table` "up to 4 rules low"), 12; TRANSFORMS 8.3; SIMPLICITY:216, :419; VERDICT:1265, :1273.
- *With many groups:* section 3's changes, R0 to R2, `slot-table`'s high rules and a write line per group add about **+6 to +26 builder rules**, +1 in `data`, and +2 to +4 user rules (reasoned; summed item by item in section 5). Growth from one voter is not in that sum: LAYERS 11 already puts it in the slice, since every founding runs it (checked). The base's place, 23rd of 24 rows, may move, since DRAFT and SPLIT price some of this (reasoned).

**X7. COST. The simulator's time bar was met on small worlds.**
- *Where:* [E-04]; [E-22] (200 seeds in 0.65 s against a 1 s bar, with 2 groups); REQUIREMENTS TEST-01.
- *With many groups:* a seeded tier with several groups on different server sets, moves and a group down costs more per seed (reasoned).

**X8. COST. Disk events on one member touch more groups (not caused by groups per resource).**
- *Where:* AMENDMENTS G-15, K-24; [E-29] (the disk-full reserve).
- *Note:* a bad entry that wipes a member's disk copies every group on it again at once, and many groups on one disk can snapshot together, so the reserve must cover that or snapshots take turns. Both already exist with many resources per member (reasoned).

### 2.9 Evidence that ran on one group

The pattern: the experiments that checked correctness across groups ran in one process or in a model, and the timed runs with `data` folding had one group per resource. [E-11] and [E-13] did spread groups' leaders over three processes, but at the Raft level only: no fold, no slots, no resource (checked: E-11's and E-13's methods). No run had one resource's groups, with `data` folding them, on different sets of servers.

**R1. UNKNOWN. The served-view evidence ran with one group.**
- *Where:* [E-57] README:200 ("Group A has one group"); TRANSFORMS 7 (A1 to A8, XA-1 to XA-13), 10 items 2, 3, 9, 10; DECISIONS V5-14's consequences; E-60 (in progress, one slot).
- *With many groups:* in those runs positions were log indexes, no slot moved, every copy held every row, and "every copy but the leader" was a clear set. XA-14 (the view selector in E-31's model) had not run (checked). [E-60] has since run it, on one slot with a move to a second group: every property holds but the old wording of END `view-too-big`, which V5-20 item 20 restates.
- *Settle by:* group A again at G = 4, 16 and changing, with hand-backs, a move and one group down; and E-60 widened to a view over two slots in two groups. **L**.

**R2. UNKNOWN. E-22's 22 patterns ran with two groups that every process folded, and with `#meta`.**
- *Where:* [E-22]'s API notes, its prototype and its patterns README; LAYERS 11 (the port is owed).
- *With many groups:* P-01, P-12 and P-16 were checked only where R0 was free. The groups sat on the same servers, one move was forced per seed, no group was added, and the API was the one before the lens. The Porcupine and Elle results hold per partition (checked by the merge from E-22's notes).
- *Settle by:* the owed port to the new spelling, run with G ≥ 4 on different server sets, a server that lacks a group, a group down and a group added. **L** (owed anyway).

**R3. HOLDS. Evidence that carries over per group or per partition.**
- [E-02], [E-11], [E-12], [E-25], [E-26], [E-35] and [E-50] measure groups per process. [E-10], [E-14] to [E-14c], [E-38] and [E-46] check Raft per group. [E-19] and [E-31] work per slot. [E-20], [E-23] and [E-30] run across groups. [E-55], [E-56] and [E-58] hold for their per-partition claims; their whole-resource claims fall under G1 to G4 and P4.

**R4. UNKNOWN. One resource's write rate across servers never ran, nor a resource bigger than one server.**
- *Where:* REQUIREMENTS SC-03 (its simulation never ran), SC-06; [E-02] README:28; [E-09c], [E-09d]; API.md:2317.
- *With many groups:* E-02 had one leader process, while the rivals spread 16 partitions' leaders over three brokers (checked). E-11 shows the Raft part: at 10,000 writes a second, 16 groups led from three processes cost the whole cluster 20 to 30 % less CPU than one group in Rust and TypeScript, and the same in Go (measured, [E-11]). But no run spread one resource's groups with `data` folding on every holder (G10), so SC-03's 0.7 × n is not shown. With one group per resource the first build cannot meet SC-03 at all (reasoned). SC-06's test, a data set at 3 × RAM, never ran (checked).
- *Settle by:* one resource with 4 to 16 groups and leaders on three processes, folding, against the same resource with one group, with 3 and with 5 holders per group; SC-06's run after G5's decision. **M**.

**R5. UNKNOWN (new). SC-05's 10 GB wake was timed in one process only.**
- *Where:* REQUIREMENTS SC-05; LAYERS 3.5 ("Limits"); [E-34].
- *With many groups:* one process wakes 10 GB of 2 KB rows in 86 to 122 s, over the 60 s bar (measured, E-34). So one group per resource cannot meet SC-05 at that size, and groups led from different servers are the way to meet it (reasoned). That is one more reason for many groups. But it works only where a server holds part of the resource (G10), and every R0 holder (a view host, a view-form deriver) still folds all 10 GB after a wake (reasoned).
- *Settle by:* a wake of 10 GB split over 4 to 16 groups on three or more processes, with and without an R0 holder. **M**.

### 2.10 The plan

**L1. BREAKS. The build order and the first slice keep one group and no move.**
- *Where:* API.md:19-24 ("What comes when"), :167; LAYERS 9.1, 9.4, 10 item 12, section 11; DESIGN-V5 4.2 (:516: "Phases 2 and 3 run one shard per resource. Moves land in phase 4"), 11; VERDICT:1281.
- *With many groups:* the read surface and the transforms (V5-12 to V5-16) come with the first build. They are built on R0 being free, on placement over "the group's" copies, and on one SUB per whole selection, and LAYERS 9.4 puts R0 to R2 after the slice (checked). G1 to G7, P4, V1 and S1 all change those parts. No resource in the slice can be bigger than one server, SC-03 fails by construction, and SC-08 is never exercised (reasoned). LAYERS 11's owed models miss the many-group cases: H6's move into a growing group, P4 and P5, the reruns of V1 and V2, G4's cost, V6, H13, O3, H8, H2, per-group memory pins (X1) and H10's timed growth (checked against LAYERS 11).
- *Needs:* section 5's plan. Add a many-groups step to API.md's "What comes when", and add the missing models to LAYERS 11. Touches LAYERS 10 item 12 and section 11 (the owner's call), DESIGN-V5 11's phases, VERDICT 9 step 4.

## 3. Every BREAKS item, with its change

| Item | What breaks | Proposed change | Decision it touches | Builder rules |
|---|---|---|---|---|
| G1 | "a server holds every row" | a copy is one group's replica; "held on purpose" per group; the partial server named | V5-12's review rule; V5-16 pick 2's words | +0 (user +1) |
| G5 | whole-resource work past one process | list the one-process ceiling in API.md 7 and SC-10; check it, warn at 80 %; owner rule for a live view past it; merger later. *Decided otherwise by V5-20: no fixed ceiling, the merger in the first build, `scan()`, folds, holds bounded by `memory`* | V5-14's frame; SC-10; SC-06 | +1 (user +1) |
| G6 | "about 135 leaders' worth" with a reader of every row | list the fold-rate ceiling (about 5 leaders, 1 with a leaderboard); point big sources to shares | V5-14's frame; SC-10 | 0 |
| G7 | no work by slot in `data` 5 | `data` 5.0.0 lists, snapshots and drops one slot's rows; one store per resource per process (or a fero-side index) | V5-14 pick 6 | +1 in `data` |
| G10 | 5 holders fold every write; groups spread nothing on 5 servers or fewer | `standbys` 0 once a resource has more than one group (owner pick); tests on 6 or more servers | V5-6; API.md's `standbys` default; SC-03; SC-06 | 0 |
| O2 | P-16's rebuilt equals live | holds for projections per partition or free of order across partitions | none (P-16's text) | 0 |
| O3 | writer time never going back | carry the slot's last stamp; B never stamps lower; state the early-lapse bound | V5-4; A-17 | +1 |
| O8 | the `memory` rung's table in a memory home group | a memory resource's home group commits on disk | V5-5 (third step) | 0 to +1, later |
| P4 | a whole link is "one SUB" | a SUB per group; ready when every picture has come; per-slot cut for resume | V5-13 pick 1 | +1 to +2 |
| V1 | views "on every copy but the leader" | hash over servers that hold R0, preferring those that lead no group of it; stalls named until sliced builds. *Decided by V5-20 item 13, over the servers that hold the rows* | V5-14 pick 3 | +1 |
| V6 | bump misses a group made during a takeover | read the target's groups again after the bumps; a bump addressed to a group | V5-14 pick 5 | +1 |
| Q1 | handler writes "at this same leader" | per-partition words, or own-partition writes only (owner pick) | V5-16 pick 3 (words) | 0 |
| H1 | layout only from the home group | every copy keeps and hands out the home records (LAYERS 10 item 22, made a rule) | V5-3 | +1 to +2 |
| H4 | home down after a fence leaves the slot stuck | B gives up with no home write if it never wrote the row | A-17 (4) | 0 to +1 |
| H6 | slots move into a one-voter group | no slot opens below `copies` voters | V5-5; A-18 | +1 |
| H7 | new groups led from the home leader's machine | place new groups by load and memory; preferred member elsewhere | V5-2's consequences; V5-10 fix 7 | 0 to +1 |
| H9 | no rule adds a group; nothing grows by size | a grow rule by size and load; pre-split at founding, import, restore | V5-2 point 3; A-18 | +1 to +2 |
| H11 | the move misses SC-08(b) | a one-commit cut form from the fused core, carried set before the fence, timed for real; or restate SC-08(b); PA-20 | A-17 (3); V5-9 | −4 to +1 (a guess) |
| H13 | the carried set is short | carry caller keys, O.seq, last stamp, row versions, tombstones, snapshot names | A-17 (2) | 0 to +2 |
| S1 | settings in force per group at different times | each group records its adoption; `fero.alter` answers once all have adopted | V5-2 point 2; V5-10 fix 3 | +1 |
| L1 | slice with one group and no move | several groups from founding; the move last in the slice (section 5) | LAYERS 10 item 12 and 11; DESIGN-V5 11 | the sum below |

**Wording fixes owed anyway, not caused by many groups:** V5-16 pick 2's "no subscription of its own" is already wrong for a spare (G3). PATHS 1.1 (:67) says `standbys` "defaults to 5", while API.md (:260, :2476) says 2, which makes 5 copies in all.

## 4. Models and measures owed, in order of what they unblock

### 4.1 Decisions first

None needs a model. Each one shapes the models after it. They are the owner's questions in 5.5: the slice, the one-process ceiling, `standbys`, SC-08(b)'s form, view placement, one group down, the home group down, growth, settings, handlers.

### 4.2 Before step 1: founding with several groups

| # | Model or measure | Settles | Size | Builds on |
|---|---|---|---|---|
| 1 | settings adopted per group, with an `alter` and the read-only gate | S1, part of O7 | S | E-51's catalog model, with two data groups |
| 2 | a client that first reaches another group's copy, with the home group down | H1 (already owed in LAYERS 11) | M | E-51's client model |
| 3 | founding with a pre-split, placed by load, preferred member on another machine | H9's pre-split, H7 | S to M | E-51's founding model, E-52's placement |
| 4 | a whole selection over two groups, a move each, one group down | P4, P5 | M | E-31 |
| 5 | R0's cost on real links, a server missing 1 of 4 and 15 of 16 groups | G4, G2's line, G10's memory | M | E-57 B1 |

About 13 to 22 days of work, or 1 to 1.5 weeks run side by side (a guess from the sizes).

### 4.3 Before step 2: the slot move

| # | Model or measure | Settles | Size | Builds on |
|---|---|---|---|---|
| 6 | the move family from the fused core: table in the home log, home group down, carried set, lost or late messages, K-01's two faults, mutants to 85 % | H12, H4, H11's shape | L | E-17b's fused probe, E-15 |
| 7 | the window, timed with a real carried set on independent disks, at 2,000 and 10,000 writes a second | H11, H14, SC-08(b) | M | E-13's chain |
| 8 | the full carried set, with caller keys beside sessions | H13, O7's O.seq part | M | E-32, G-12 |
| 9 | growth from one voter, with a move into the growing group | H6 | S to M | E-59 |
| 10 | a grow rule by size and load, with time | H9 | M | E-18 |
| 11 | writer time with a move between groups that have different members | O3 | S | E-21, K-11 |

About 17 to 32 days of work, or 2 to 3 weeks run side by side (a guess).

### 4.4 Beside the build

Each of these gains a many-group case; most are already owed in LAYERS 11.
- **Served views and `derive`:** R1 (L), V2 (L, inside R1), V5 with V6's check (M to L), V3 (M), V8 (M), V7 (S to M).
- **Placement, growth and failure:** H8 (M to L), H10 (L, needs a working move), H2 (S to M), H3 (S to M), H15 (M).
- **Order and history:** O7 (M), P6 (S), P7 (M), P8 (M), P9 (M to L).
- **Libraries:** Q2 (S), Q4 (M), Q7 (S), Q8 (M), Q9 (M), Q10 (S, a decision), Q11 (S), Q14 (S), R2 (L, owed anyway).
- **Scale:** R4 (M), R5 (M), the PATHS walk-throughs with many groups (X5).
- **Only with the `memory` rung:** O8 (M).

## 5. The recommendation for the first build

### 5.1 The answer

**Found every resource with several groups in the first build, in two steps inside the first slice.**

**Step 1, from the first day.** Every resource in the simulator, the tests and the examples is founded with a fixed pre-split: 2 to 4 groups placed on different server sets, with no live move.
- **Test worlds must hold partial servers.** With 5 holders per group, a world of 5 servers or fewer has none (G10). So the tiers run 6 or more servers, or `standbys: 0` on 4 or more.
- **What it brings out:** most BREAKS (G1, G5 to G7, G10, O2, P4, V1, Q1, S1, H1, H7), the costs of G2 to G4 and Q3, the extra order apps could lean on (O1), and P5's question.
- **What it needs:** R0 to R2 (+1 to +4), home records on every copy (H1, +1 to +2), settings adopted per group (S1, +1), whole selections over groups (P4, +1 to +2), view placement (V1, +1), the ceiling check (G5, +1; V5-20 replaced it with EVERYROW's `memory` guard, which LAYERS 0.2 counts), a pre-split at founding (part of H9, +1), new-group placement (H7, 0 to +1), and maybe a write line per group (Q3, 0 to +1). About **+7 to +14 builder rules, +1 in `data` (G7), +2 to +3 user rules** (reasoned).
- **What it does not do:** meet SC-03. Two to four fixed writers sit far below F_w = 64, and SC-03 asks for no count chosen up front (checked: REQUIREMENTS SC-03). Step 1 is a test shape, not the scaling answer.

**Step 2, last in the slice.** The slot move in a cut form, once model 6 passes and model 7 has timed the window. With it come the voter rule for new groups (H6, +1), the grow rule (the rest of H9, 0 to +1), the stamp carry (O3, +1), the full carried set (H13, 0 to +2), the give-up without the home group (H4, 0 to +1), the bump's second read (V6, +1), `slot-table`'s high rules (0 to +4), and the cut move itself (−4 to +1, a guess). About **−1 to +12 builder rules** (reasoned).

**Together:** about **+6 to +26 builder rules** on the first build's 446 to 503 (1 to 6 %), **+1 in `data`**, and **+2 to +4 user rules** (reasoned). The user rules: a server may hold only some groups (G1); whole-resource work needs the resource to fit one process (G5; V5-20 replaced it: a sync read of every row fits the process's `memory`, and other work over every row has no row ceiling); and maybe what a read over every row does while a group is down (P5) and where a handler may write (Q1).

### 5.2 Why not one group first

1. The first build puts the read surface (V5-12 to V5-16) and the transforms (V5-14) on "a server holds every row", "R0 is free" and "one SUB per selection". 21 BREAKS items say those change. Building on one group means building those parts twice (reasoned).
2. A one-group build shows more order and more fencing than fero promises (O1). Tests on it cannot catch apps that lean on that; E-22's shuffle shows such apps exist (measured, [E-22]: 25 of 100 seeds).
3. data 5.0.0 is planned as one major version (V5-14 pick 6). Its work by slot (G7) belongs in it, not in a second major later (reasoned).
4. With one group per resource, SC-03 cannot be met, SC-05 misses at 10 GB (86 to 122 s against 60 s, measured, [E-34]), SC-06 cannot be met, and SC-08 is never exercised (reasoned). Only step 2 changes SC-03; step 1 alone does not.
5. The Raft part already favours spread leaders. In E-11, 16 groups led from three processes cost the cluster 20 to 30 % less CPU than one group, in TypeScript and Rust (measured, [E-11]).
6. Many groups add rules, but not rules that a one-group build avoids. The same rules come later, plus the rework (reasoned).

### 5.3 Why not the move from the first day

- The only modelled form misses SC-08(b) under load: at 10,000 writes a second, three commits take 16.7 ms at p99, two take 12.77 ms and one takes 4.56 ms, against 10 ms (measured, [E-13]).
- E-13 sent no bytes. The real window could be larger (the carried set, up to 16 MB a move at 1e6 clients) or smaller (independent disks halve p99) (reasoned). It must be timed with real bytes before anyone trusts a form.
- Its home-log form, with the home group down, is not modelled (H4, H12). The fused core is modelled, crash-only, and caught every mutant that changes anything (checked: [E-17b], [E-17c]); the drafted move's models caught 39 % of mechanical mutants, mostly because of spare guards (checked: [E-15]).
- Putting the move last in the slice, behind its model and its timing, means the slice does not wait on it, and the move still ships in the same slice.

### 5.4 What each way costs

| | Several groups now (recommended) | One group now, many later |
|---|---|---|
| Builder rules in the first slice | +6 to +26 on 446 to 503 (1 to 6 %), +1 in `data`; +2 to +4 user rules (reasoned) | about +0 for groups |
| Rules later | none more for groups | the same rules, plus rework of the parts built on one-group shortcuts: the `'server'` types and `RootOps`, the selection registry, view placement, the test tier (reasoned) |
| `data` | work by slot inside data 5.0.0 | a second `data` major later |
| Models before step 1 | 4.2's five: about 13 to 22 days of work, 1 to 1.5 weeks side by side (a guess) | none |
| Models before step 2 | 4.3's six: about 17 to 32 days of work, 2 to 3 weeks side by side (a guess) | none now |
| Models beside the build | 4.4's list; most already owed in LAYERS 11, now with a many-group case | the same, later, after the code exists |
| What the slice proves | partial servers, R0 downloads, a group down, settings windows, order across groups; then moves and growth | one-group behaviour only; SC-03, and SC-05 at 10 GB, fail |

### 5.5 Questions for the owner, one at a time, most important first

**All answered.** V5-18 answered questions 1, 2 (in part), 4, 5 and 7 to 11 on 2026-11-21, and left 3, 6 and 12 for MERGE.md. V5-20 answered those on 2026-11-23, and changed V5-18 pick 5 for live merged views. Each question below ends with its answer.

1. **The first slice (L1, G10, H11).** Should the first slice found every resource with several groups from the first day, tested on worlds where some servers hold only part of a resource, and take the slot move last in the same slice once it is modelled and timed? Or keep one group and no move? *Answered: several groups from the first slice, tested on 6 or more servers, the move last in the same slice (V5-18 pick 1).*
2. **Past one process (G5, G6).** For a resource bigger than one process, or busier than one process can fold, should whole-resource features be refused at a stated ceiling now, with a merger across groups as a later design? Or should the merger be designed now? *Answered: designed now (V5-18 pick 2), and then no fixed ceiling and the merger in the first build, with `scan()`, folds and a sorted column (V5-20 items 1 to 6).*
3. **A live view past the ceiling (G5).** When a resource grows past that ceiling while a served view is live, should the view keep serving with a health warning, end with a code, or should growth wait? *Answered: there is no ceiling to grow past (V5-20 item 3). A merged view keeps serving at any size; a live hold that passes its process's `memory` line ends `not-held`, and keeping it with only a warning is rejected.*
4. **`standbys` with many groups (G10).** Once a resource has more than one group, should `standbys` default to 0, so a write is folded on 3 servers instead of 5 and groups spread memory? *Answered: yes (V5-18 pick 3).*
5. **The move's bar (H11).** Should SC-08(b) be restated as a p50 bar plus a p99 bar tied to load? Or stay 10 ms at p99, which needs a one-commit window with the carried set sent before the fence? *Answered: it stays 10 ms at p99, with the move cut to one commit, modelled and timed before it ships (V5-18 pick 4).*
6. **Where served views live (V1).** Once leaders spread over servers, should a served view live only on a server that leads no group of its resource, or on any server that holds the rows, with build stalls reaching writers until `data` builds in slices? *Answered: on any server that holds the rows, preferring one that leads no group of its resource; build stalls can reach a leader's writes until `data` builds in slices (V5-20 item 13).*
7. **One group down (P5).** While one group is down, should reads over every row wait, with a health row naming the group, or answer for the live slots with a mark that names the missing ones? *Answered: they wait, and health names the group (V5-18 pick 5). For live merged views V5-20 item 2 changes it: the view keeps serving with the down group's part frozen, and a one-time fresh read waits. Through a merger rebuild the view serves nothing new until the group is back (V5-22 item 4).*
8. **The home group down (H1, H4).** Should a client that has never seen the resource still reach its live groups while the home group is down, by taking a maybe-stale table from any copy? And may a move's target give up without the home group? *Answered: every copy keeps and hands out the home group's records, so a new client reaches live groups (a stale entry answers `moved`); a move's target that never wrote the slot may give up without the home group (V5-18 pick 6).*
9. **Growth (H6, H9, H10).** Must a new group have all its voters before any slot moves in? Should a resource grow by size as well as by load, and start split when it is founded, imported or restored with a size hint? What is the target time to grow from one group to sixteen under load? *Answered: all voters first; growth by size and by load; split at founding, import and restore from a size hint; the target is set after a timed growth from 1 to 16 groups (V5-18 pick 7).*
10. **Settings (S1).** Should a settings change, the read-only gate included, count as in force only once every group has adopted it, with `fero.alter` waiting for that? *Answered: yes (V5-18 pick 8).*
11. **Handlers that touch other rows (Q1).** May a row handler write rows in other partitions, with the extra trips and no order across groups said on the page, or only its own partition? *Answered: it may write other partitions, with the trips and the lack of order across groups stated (V5-18 pick 9).*
12. **Servers that hold some groups (G2, G3).** Does API.md's reading for a spare (download what is missing first, and say the cost on the line) also cover a server that holds some groups but not all? *Answered by V5-20 items 1 and 3 to 5: one-time work reads by `scan()`, with no download; live work that merges or folds is served; only a sync read of every row takes what the server lacks, under its `memory`.*

**Later, with the `memory` rung only:** must a memory resource's home group still commit on disk (O8)? *Not yet asked.*

**Small and safe, taken without a question:** O2's wording for P-16, O3's stamp carry, H13's full carried set, G3's wording, G6's ceiling line, and the PATHS default.

## 6. What this page did not check

- **No new runs or models.** Every number comes from the experiment named beside it; everything else is reasoning, marked as such.
- **Line numbers** come from the five passes. The main claims of every BREAKS item, and every claim the skeptic raised, were read again in the sources. Not every line of every "Where" list was opened again.
- **HOLDS items** were not checked again one by one beyond their named evidence.
- **Rule counts** are reasoned per item. Nobody counted them by SIMPLICITY's method (DEV-10). The cut move's count rests on a probe and a guess.
- **Times and sizes** of models are guesses from the size of the model each one extends.
- **E-59 to E-62 were in progress** when this page was written. They were read as drafts, if at all. They have since reported: [E-59], [E-60] and [E-61] fed V5-20, and [E-62] measured the read costs.
- **Not studied:** regions (SC-14) with many groups; the browser client ([E-40]) with a SUB per group; hosted cost per group ([E-41], DEP-21); fero deploy and the CLI's `move` and `place`; v4's code and its examples; `data`'s code (only its planned list).
- **Not priced:** a fero-side key-to-slot index (G7's other option) against the memory budget; G10's write-scaling figure with the followers' Raft and fsync work added.

[E-02]: experiments/E02-pipeline/README.md
[E-04]: experiments/E04-wasm-kernel/README.md
[E-05]: experiments/E05-fold-cost/README.md
[E-09c]: experiments/E09c-kafka/README.md
[E-09d]: experiments/E09d-redpanda/README.md
[E-10]: experiments/E10-raft-port/README.md
[E-11]: experiments/E11-many-groups/README.md
[E-12]: experiments/E12-journal/README.md
[E-13]: experiments/E13-handover/README.md
[E-14]: experiments/E14-membership-on-commit/README.md
[E-14b]: experiments/E14b-membership-liveness/README.md
[E-14c]: experiments/E14c-membership-completion/README.md
[E-15]: experiments/E15-slot-move-tla/README.md
[E-16]: experiments/E16-controller-loop/README.md
[E-17b]: experiments/E17b-partitioning-part2/README.md
[E-17c]: experiments/E17c-partitioning-rerun/README.md
[E-18]: experiments/E18-slot-balance/README.md
[E-19]: experiments/E19-slot-positions/README.md
[E-20]: experiments/E20-dedup/README.md
[E-21]: experiments/E21-time/README.md
[E-22]: experiments/E22-api-prototype/README.md
[E-23]: experiments/E23-merged-views/README.md
[E-24]: experiments/E24-sagas-ramp/README.md
[E-25]: experiments/E25-idle-fd/README.md
[E-26]: experiments/E26-dormant-groups/README.md
[E-28]: experiments/E28-minio-log/README.md
[E-29]: experiments/E29-power-loss-disk-full/README.md
[E-30]: experiments/E30-derived-once/README.md
[E-31]: experiments/E31-subscribe/README.md
[E-32]: experiments/E32-composition/README.md
[E-33]: experiments/E33-genesis-restore/README.md
[E-34]: experiments/E34-wake-10gb/README.md
[E-35]: experiments/E35-neighbours/README.md
[E-36]: experiments/E36-many-resources/README.md
[E-37]: experiments/E37-bad-entry/README.md
[E-38]: experiments/E38-raft-gray-failures/README.md
[E-40]: experiments/E40-browser-client/README.md
[E-41]: experiments/E41-hosted-cost/README.md
[E-43]: experiments/E43-fold-versions/README.md
[E-45]: experiments/E45-drivers/README.md
[E-46]: experiments/E46-maelstrom-raft/README.md
[E-47]: experiments/E47-memory-rung/README.md
[E-48]: experiments/E48-ack-stages/README.md
[E-49]: experiments/E49-per-resource-cost/README.md
[E-50]: experiments/E50-path-costs/README.md
[E-51]: experiments/E51-resource-founding/README.md
[E-52]: experiments/E52-resource-healing/README.md
[E-53]: experiments/E53-handback-pace/README.md
[E-55]: experiments/E55-lens-prototype/README.md
[E-56]: experiments/E56-one-connect/README.md
[E-57]: experiments/E57-transforms/README.md
[E-58]: experiments/E58-any-path/README.md
[E-59]: experiments/E59-growth-and-stop/README.md
[E-60]: experiments/E60-view-selector/README.md
[E-61]: experiments/E61-marks-from-code/README.md
[E-62]: experiments/E62-read-costs/README.md
