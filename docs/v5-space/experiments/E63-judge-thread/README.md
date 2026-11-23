# E-63: which thread judges writes?

**Question.** LAYERS section 10 item 1, and the kill row in its 3.6 (VERDICT 9, row "6a, with L2 on the main thread"). *Judging* is checking a write against the rows (its shape, its condition, its op) and then turning it into records, or refusing it. The study's design rule puts judging on the **main thread**, beside `data`'s own rows ([VERDICT 3.3](../../VERDICT.md#33-which-data-01-reading-the-brief-supports), LAYERS 3.4; PATHS walks every path that way): form **A** here. [DESIGN-V5 4.3](../../../DESIGN-V5.md) put it on the **kernel worker**, which then needs its own copy of the rows: form **B**. This experiment measures both before the choice is made. The kill test: rerun [E-07](../E07-gc-worker/README.md)'s 5 s stall of the leader's main thread with judging on main, against **F-14** ("a 5 s main-thread stall keeps writes going") and **P-01** (write p99 ≤ C + 5 ms = 5.73 ms in TypeScript, at PERF-09's 50,000 writes a second).

**Short answer.** **F-14 decides it, and P-01 does not. Judge on the kernel worker, and run user rules there under a time budget for each turn. No form meets P-01's 5.73 ms on this box, the control included, and on P-01 judging on main and judging on the worker cost about the same.** A review found that the first version's P-01 numbers came from one event, so P-01 is now read at 900,000 rows; the review and what changed are [at the end](#what-the-review-found-and-what-changed).
- **A fails F-14** *(measured)*. In a 5 s main-thread stall the leader answered **0 %** of about 250,000 writes, in every run, on every row set. Heartbeats went on (timer gaps 101-103 ms at 900,000 rows), so there was no false failover; the writes waited, and the last of them was answered 1.8 to 1.9 s after the stall.
- **The worker forms meet F-14 for a stall on main** *(measured)*: B, Bs and B2 answered **99.9 %** of stall writes, with a longest silence of 14 to 48 ms.
- **But user code that judges runs on the worker in B, and a stall there is worse than a stall on main** *(measured)*. When one call of a user rule looped for 5 s, B and B2 answered 0 %, and the kernel thread stopped: no heartbeat for 5.0 to 5.1 s, and the followers heard nothing for 5.0 s, which in a real group starts an election. A budget of 10 ms for each turn's `vm` call fixed it (99.8 %, longest silence 13 to 67 ms), but it costs about 0.3 of a core on the worker (busy share 0.93 to 0.95 against 0.63 to 0.66), and it also cut 1 to 3 turns of ordinary writes a run that ran over 10 ms with no stall at all.
- **P-01 is missed by every form, and it does not separate the threads** *(measured)*. At 900,000 rows the control that judges nothing has p99 **5.7 to 13.2 ms**. Run by run in the same hold, judging adds: A **+0.9 to +10.2 ms**, B2 **+1.7 to +8.8**, B **+3.6 to +33.0**, M3 +0.1 to +7.9 (A over six runs in two holds, B and B2 over nine runs in three).
- **The first version's 1,000,000-row tails were one table rebuild** *(measured)*. V8 keeps a `Map` in one hash table and rebuilds it when it fills. At 1,000,000 rows that came about 9.7 s into every run, inside the steady window: A's p99 was 140 to 441 ms and B's 250 to 309 ms there. B2, whose worker holds no `Map`, kept 13.5 to 20.2 ms, but main still rebuilt `data`'s table. The rebuild comes once each time a table fills (here again about 220 s later), so over a long window it moves p99.9, not p99 *(reasoned)*.
- **The cheap middle forms** *(measured)*. M2 (a GC flag) answered 0 %. M1 (the worker appends plain writes itself) kept plain writes going (93.9 %) but no judged write (0 %), and a client with fero's 512-write cap is full 10 to 14 ms into the stall. M3 (a watchdog hands the leadership to a peer) answered 99.9 % after one gap of **517 to 551 ms** (W = 500 ms) or 206 to 233 ms (W = 200 ms).
- **Memory for the second copy** *(measured, 900,000 rows)*: B +296 MB of worker heap and +350 MB RSS after the load, +547 MB at the run's peak; B2 +234 MB after the load, +26 MB at the peak. Every server pays it, not only leaders.
- **Rules** *(reasoned)*: A 0; M2 0; M1 +3 to +5; M3 +2 to +4; B, Bs and B2 +3 to +8.
- **Fewest rules.** If one pause of about W counts as "keeps writes going", M3 meets F-14 with the fewest rules (+2 to +4) and judging stays on main. If it does not, only the worker meets F-14, with B2 (or B) and a rule budget for each turn (+3 to +8). No form meets P-01 here, so P-01 picks neither.

**Words.** The *leader* is the server that orders a group's writes. Its *kernel worker* is a second JavaScript thread that holds the links, the journal and the commit; its *main thread* holds `data`'s rows and the app. A *stall* is a thread stuck in code that never yields. A *plain write* is a whole-row set or remove with no condition: no row can make it fail. The *overlay* is the writes a judge has accepted that are not yet in the rows it reads. A *hand-over* moves a leadership to another server. A *user rule* is app code that judges a write (`rules.write`, `validation`, `schema`, a claim's `where`); a *budget* is a time limit on it, here a `vm` timeout. A *table rebuild*: V8 keeps a `Map` in one hash table; when its entries, live and removed, fill the table, V8 builds a new one (twice the size, or the same size when many entries are removed) in one go, and the thread waits for it. *p99* is the latency 99 % of writes beat. *GC* is V8's garbage collector. The *event-loop delay* (ELD) is how late a thread's 1 ms timer fires: a long block of work shows as a long delay. A thread's *busy share* is the part of a window it spent running rather than waiting (Node's event-loop utilization). A *hold* is one stretch of runs alone on the box under the timing lock.

**Marks.** *(measured)*: timed, three runs, each alone on the box under its timing lock; the range over the runs. *(checked)*: a run's own check, or the code read line by line. *(reasoned)*: an argument, not run. *(a guess)*: nobody measured it.

## Against the bars

900,000 small rows (E-05's row), the review holds, unless it says otherwise. The median of three runs, with the lowest and highest run in brackets. "Above the control" is each run's p99 minus the control's p99 in the same run of the same hold. The last P-01 column is the first holds on 1,000,000 rows, where one table rebuild fell in the window.

| Form | P-01: write p99 at 50,000 writes a second (bar 5.73 ms) | above the control, run by run | 1,000,000 rows: p99 with one table rebuild in the window | F-14: writes answered during the 5 s stall | longest time with no answer in the stall | extra memory a server, after the load / at the peak (against A) | rules added (reasoned) | meets |
|---|---|---|---|---|---|---|---|---|
| none (the control: no judging) | 6.96 ms (6.47-7.19); hold b 8.92 (7.22-13.23) *(measured)* | (the control) | 9.92 (8.88-10.75) | 100.0 % (99.9-100.0) *(measured)* | 17 ms (10-22) | 0 | (not a design) | neither bar on this box; it is the floor |
| **A** main judges | **12.88 ms (11.28-16.68)** *(measured)* | +4.1 to +10.2; GC-log hold +0.9 to +3.4 | 168.01 (140.36-441.28) | **0.0 %** *(measured)* | **4,997 ms (4,996-4,997)** | 0 | 0 | **neither** |
| M2 A with a 64 MB young generation | 15.47 ms (13.50-17.14) *(measured)* | +7.0 to +10.2 | 66.13 (53.08-98.04) | 0.0 % *(measured)* | 4,998 ms | +93 / +88 MB RSS | 0 | neither |
| M2 A with a 2 MB young generation | 9.46 ms (8.58-14.24) *(measured)* | +1.4 to +7.8 | 107.74 (62.33-214.63) | 0.0 % *(measured)* | 4,999 ms | +102 / -13 MB RSS | 0 | neither |
| M1 worker appends plain writes | 14.09 ms (13.45-14.40); plain 9.09, judged 15.22 *(measured)* | +7.0 to +7.2 | 84.38 (44.59-153.56) | 32.9 %: plain 93.9 %, judged 0.0 % *(measured)* | 25 ms (22-26) | 0 | +3 to +5 | neither: judged writes stop |
| M3 A + watchdog, W = 500 ms | 10.67 ms (7.29-11.33) *(measured)* | +0.1 to +4.4 | 106.74 (64.85-203.95) | 99.9 % (99.9-100.0) *(measured)* | **523 ms (517-551)** | 0 | +2 to +4 | F-14 only if a 0.52-0.55 s pause counts |
| M3 A + watchdog, W = 200 ms | 9.92 ms (9.53-14.91) *(measured)* | +2.3 to +7.9 | 74.03 (44.59-145.60) | 99.9 % (99.9-100.0) *(measured)* | 226 ms (206-233) | 0 | +2 to +4 | as above; at 1,000,000 rows it fired once with no stall |
| **B** worker judges, rows as objects | **16.22 ms (15.19-16.94)**; hold b 13.96 (13.83-46.27) *(measured)* | +8.2 to +9.8; hold b +5.0 to +33.0; GC-log hold +3.6 to +7.0 | 251.72 (250.23-308.53) | **99.9 %** (99.8-99.9) *(measured)* | 19 ms (17-23); hold b 26 (22-48) | +296 MB heap; RSS +350 / +547 MB | +3 to +8 | F-14 for a stall on main |
| Bs B with each `Map` cut into 256 | 18.35 ms (17.42-33.00) *(measured)* | +10.5 to +26.5 | not run | 99.9 % (99.8-99.9) *(measured)* | 23 ms (21-41) | +296 MB heap; RSS +371 / +582 MB | +3 to +8 | as B |
| **B2** worker judges, rows off the heap | **14.51 ms (10.97-15.25)**; hold b 16.05 (12.15-17.08) *(measured)* | +4.0 to +8.8; hold b +2.8 to +8.2; GC-log hold +1.7 to +6.3 | 15.42 (13.54-20.20), a later hold | **99.9 %** (99.8-100.0) *(measured)* | 18 ms (16-22); hold b 15 (14-20) | RSS +234 / +26 MB (11 MB heap) | +3 to +8 | F-14 for a stall on main |
| B+rule: the stall in a user rule on the worker | 24.24 ms (16.83-27.78) *(measured)* | +7.9 to +20.6 | not run | **0.0 %** *(measured)* | **5,000 ms**; no heartbeat for 5.0-5.1 s | as B | (B without `rule-budget`) | **neither** |
| B+budget: the same, 10 ms a turn | 19.78 ms (16.77-21.57) *(measured)* | +8.3 to +10.9 | not run | 99.8 % (99.5-100.0) *(measured)* | 16 ms (13-28) | as B | +3 to +8 | F-14 |
| B2+rule | 13.62 ms (13.19-26.22) *(measured)* | +4.7 to +13.0 | not run | **0.0 %** *(measured)* | **5,000 ms**; no heartbeat for 5.0 s | as B2 | (B2 without `rule-budget`) | **neither** |
| B2+budget | 20.42 ms (17.66-20.51) *(measured)* | +7.2 to +11.6 | not run | 99.8 % (99.7-100.0) *(measured)* | 35 ms (16-67) | as B2 | +3 to +8 | F-14 |

In every form the steady p99 is above P-01's bar, the control's too. P-01's bar was not testable on this box; see [Limits](#limits).

## The forms

All forms share one harness and one judge ([bench/common.mjs](bench/common.mjs)); they differ only in which thread judges and on which rows.

| Form | Who judges | On which rows | What else |
|---|---|---|---|
| **A** | main | `data`'s rows plus main's overlay | LAYERS 3.4's reading. The worker hands main the client's bytes and gets back the judged entry |
| **M2** | main, as A | as A | one V8 flag on the leader: a young generation of 64 MB or of 2 MB a semi-space (`--max-semi-space-size`) |
| **M1** | main, but the worker appends plain writes itself | as A; the worker reads no rows | a plain write goes straight to the log when no write of its row is waiting at main; main's overlay hears of it in the same turn |
| **M3** | main, as A | as A | a watchdog: when main has not answered the worker's ping for W (500 ms or 200 ms), the worker hands the leadership to a follower whose main is healthy and tells the client `moved`; the client resends what is unanswered |
| **B** | the kernel worker | its own copy: a `Map` of row objects and a `Map` of versions, plus its own overlay | every server keeps the copy (any copy may lead); a follower's worker decodes each committed entry a second time to keep it. DESIGN-V5 4.3's placement |
| **Bs** (added after review) | the kernel worker | as B, but each of the two `Map`s is cut into 256 `Map`s by the key's slot ([ShardedMap](bench/common.mjs)), so no one table holds a million keys | as B |
| **B2** | the kernel worker | as B, but the copy is off the V8 heap: one arena of rows as JSON and an index in typed arrays ([CompactRows](bench/common.mjs)) | as B |
| **+rule** (added after review) | as the B form it follows (B+rule, B2+rule) | as that form | every write also runs a user rule on the worker: the turn's writes go through one `vm` call that calls the rule once a write. The rule accepts every write. The stall moves from main into the rule: at the stall time one call of it loops for 5 s, and main does not stall |
| **+budget** (added after review) | as above | as above | the same, with a budget for each turn: the `vm` call has a 10 ms timeout. The write whose rule ran over is refused `rule-timeout`, and the turn's later writes run again in a new call |
| **none** | nobody: the worker appends every write as it came | none | the control: E-07's worker. It shows the harness's own floor |

## How it was measured

Everything ran in Node 22.22.0 on the study box (4 vCPU, 15 GB, Linux 6.18 Firecracker VM, one virtio disk). [tree.sh](tree.sh) builds E-07's scratch tree: fero's `api/substrate.ts`, `kernel/env.ts` and `kernel/codec.ts` with `data` linked beside them ([results/versions.txt](results/versions.txt) for the first holds, [results/versions-review.txt](results/versions-review.txt) for the review holds: the same `data`, fero one docs commit later). Nothing in fero or `data` is changed. The code is in [bench/](bench).

- **The group.** Three server processes on loopback and one client process, all on the one box. Each server is a main thread and a kernel worker ([bench/server.mjs](bench/server.mjs)); server 0 leads.
  - **The kernel worker** holds every link (to the other servers and to the client), the journal (E-02's group commit: whatever is queued goes out in one `writev`, then one `fdatasync`, on the real disk), the commit rule (an entry commits once two of the three journals have it), a heartbeat every 100 ms, and the answers: a write is answered from the worker once its entry commits, with `ok` or its refusal.
  - **The main thread** holds `data`'s rows and folds every committed entry through `data`'s lane, one lane call per entry, from the committed bytes. Beside the rows it keeps a version per row and the session table, both from committed entries.
  - **An entry** is one judged batch: a small header, each record's attempt number and slot sequence, then the records as one fero codec frame (v4's codec, with its crc32c). The same bytes are the `APPEND`, the journal row and what crosses to main.
  - **A stand-in, not a product.** No Raft election, snapshot, restart or relay; the client sends straight to the leader's worker. The log is E-02's pipeline with a commit index carried on each `APPEND` and heartbeat; M3 adds a leadership transfer.
- **The judge** ([bench/common.mjs](bench/common.mjs)) checks, in order: the session table (a repeated attempt is answered as such); the key (`__proto__` is `bad-key`); then, against the log end (the committed rows plus the overlay): a field write needs its row (`absent-row`) to be an object (`bad-shape`); `incr` needs the row and a number (`conflict`); a conditional whole-row set (`if: { equals }` on the row's region) needs the row and a match (`conflict`); a plain set and a plain remove need nothing, and a remove of a missing row commits nothing and answers as done. It writes the result as change records and updates the overlay. Folding a committed record lowers its row's overlay count; at zero the overlay entry goes.
- **The load** ([bench/client.mjs](bench/client.mjs)): 50,000 writes a second (PERF-09's TS rate, the rate of VERDICT's row 6a), or 75,000 in the three cells that test 1.5 times the rate. The writes due each 1 ms go in one `ASK` frame of JSON, open loop: the client never waits for answers, so a stalled leader shows as writes waiting. The mix keeps the row count flat, as E-07's did: 40 % field writes, 15 % `incr`, 10 % conditional whole-row sets (half name the wrong region and are refused `conflict`), 15 % plain whole-row sets, 10 % plain sets of a new row, 10 % plain removes of the oldest row. Plain writes are 35 %. That is P-01's rate, but E-07's stress shape, not P-01's own example of a few rows.
- **Rows**: 900,000 small rows (E-05's row, about 100 B) in the review holds; 1,000,000 small rows or 100,000 rows of about 2 KB (E-07's `big`) in the first holds. They are loaded into every server, and every B-form worker, before the run, as E-07 loaded them. Why 900,000: 1,000,000 is 48,576 keys short of 2^20, and the mix adds about 5,000 new keys a second, so every big `Map` filled its table about 9.7 s into each run, inside the steady window. 900,000 rows leave about 30 s of room, longer than a run *(reasoned; the probe at 900,000 rows shows no long tick)*.
- **One run** ([bench/run.mjs](bench/run.mjs)): 3 s of warm-up, 10 s of steady load, a **5 s stall**, 5 s after it, then the client waits until every write is answered. The stall is a busy loop that never yields (E-07's `busy`): on the leader's main thread, or, in the +rule and +budget cells, inside one call of the user rule on the leader's worker. The steady numbers count writes sent from 3 s until 200 ms before the stall. Write latency is the client's, from the send to the answer's arrival, so it holds two loopback hops beyond the leader's commit. Each thread's busy share and the process's cores are taken over the steady window (recorded from the review holds on). At the end every server, and every B-form worker, prints a digest of its rows.
- **GC and the side probes.** Separate runs of none, A, B and B2 logged every GC pause on each leader thread (`GCSTATS=1`; the log is the only change), once in the first holds on each row set and once on 900,000 rows. A first side probe ([bench/spikes.mjs](bench/spikes.mjs)) ran the steady load's row work alone on one thread, with no I/O, on each row store, to see which ones block for long. A second one, added after review, ran B's two `Map`s whole and cut into 256, at 1,000,000 and 900,000 rows, `data`'s lane with versions at 900,000, B2's store followed by its upkeep as one block, and [bench/budget.mjs](bench/budget.mjs), the cost of a `vm` budget a write and a turn.
- **Timing.** Every timed process ran under the timing lock (the box alone), in holds: runs 1, 2 and 3 of the cells, the cells in a fixed order inside a run. Each run's line is preceded by the load average. Every process had `--max-old-space-size=3800`, so none could pass 4 GB of heap. The holds, in order:
  - **First holds** (before review): 1,000,000 small rows, eight cells; 100,000 big rows, nine cells; then none, A, B and B2 with the GC log on each row set; then the first side probe. B2 and the GC log were added after the first hold, so B2's runs on 1,000,000 rows ran in a later hold than the other forms'. Run 2 of A on 2 KB rows lost a port race on its first try and was run again in a later hold. The side probe's first hold did not deliver its GC log; it was fixed and the whole probe ran again.
  - **Review hold a**: 900,000 small rows, ten cells (none, A, both M2, M1, both M3, B, Bs, B2).
  - **Review hold b**: 900,000 small rows, ten cells (none, B, B2, B+rule, B+budget, B2+rule, B2+budget, and none, B and B2 at 75,000 writes a second).
  - **Review GC-log hold**: none, A, B and B2 on 900,000 rows, the GC log on.
  - **The second side probe**, three runs.

## Results

The full tables are [results/tables.md](results/tables.md), printed by [summarize.mjs](summarize.mjs) from [results/runs.jsonl](results/runs.jsonl) and [results/spikes.jsonl](results/spikes.jsonl). The median of three runs, the lowest and highest in brackets.

**Steady load, 900,000 small rows** *(measured)*. Write latency at the client, ms; the busy share of the leader's two threads.

| Form | hold | p50 | p99 | above the control, run by run | p99.9 | ELD main p99 / max | ELD worker p99 / max | main busy | worker busy | leader cores |
|---|---|---|---|---|---|---|---|---|---|---|
| none | a | 1.67 (1.53-2.00) | 6.96 (6.47-7.19) | | 14.6 (12.4-18.5) | 4.8 / 21 (20-21) | 2.5 / 8 | 0.36 | 0.44 | 0.83 |
| A | a | 2.56 (2.42-2.81) | 12.88 (11.28-16.68) | +4.1, +10.2, +5.9 | 23.7 (19.6-33.0) | 10.7 / 65 (65-76) | 2.8 / 9 (6-13) | 0.69 | 0.29 | 1.03 |
| M2, 64 MB | a | 2.47 (2.11-2.59) | 15.47 (13.50-17.14) | +8.3, +7.0, +10.2 | 33.0 (19.3-42.3) | 9.0 / 39 (34-51) | 2.5 / 8 (7-16) | 0.66 | 0.30 | 1.00 |
| M2, 2 MB | a | 2.45 (2.43-2.84) | 9.46 (8.58-14.24) | +1.4, +7.8, +2.5 | 18.2 (14.3-19.7) | 7.8 / 105 (44-291) | 2.4 / 7 | 0.71 | 0.29 | 1.02 |
| M1 | a | 2.94 (2.68-2.98) | 14.09 (13.45-14.40); plain 9.09, judged 15.22 | +7.2, +7.0, +7.1 | 25.2 (20.9-35.8) | 11.4 / 46 (42-118) | 3.4 / 7 (6-10) | 0.65 | 0.57 | 1.15 |
| M3, 500 ms | a | 2.23 (2.03-2.38) | 10.67 (7.29-11.33) | +0.1, +4.2, +4.4 | 18.0 (14.2-21.6) | 8.0 / 64 (22-80) | 2.7 / 6 (6-8) | 0.64 | 0.28 | 0.98 |
| M3, 200 ms | a | 2.34 (2.11-2.38) | 9.92 (9.53-14.91) | +2.3, +3.5, +7.9 | 19.8 (18.2-46.9) | 8.3 / 39 (39-41) | 2.6 / 8 (7-9) | 0.65 | 0.29 | 1.00 |
| B | a | 4.47 (4.31-4.64) | 16.22 (15.19-16.94) | +9.8, +9.7, +8.2 | 24.3 (23.9-25.3) | 7.4 / 32 (27-33) | 5.2 / 15 (15-17) | 0.36 | 0.66 | 0.94 |
| Bs | a | 5.33 (5.30-6.34) | 18.35 (17.42-33.00) | +11.2, +26.5, +10.5 | 26.8 (25.5-62.0) | 7.4 / 32 (27-41) | 6.0 / 17 (16-38) | 0.35 | 0.70 | 0.96 |
| B2 | a | 3.30 (2.79-3.93) | 14.51 (10.97-15.25) | +7.3, +8.8, +4.0 | 27.4 (20.8-44.9) | 5.7 / 22 (21-33) | 3.8 / 8 (7-12) | 0.34 | 0.63 | 0.93 |
| none | b | 1.67 (1.32-2.43) | 8.92 (7.22-13.23) | | 25.3 (18.4-26.2) | 5.2 / 19 (17-43) | 2.7 / 16 (15-18) | 0.36 | 0.43 | 0.78 |
| B | b | 4.12 (3.45-10.42) | 13.96 (13.83-46.27) | +33.0, +5.0, +6.6 | 20.9 (19.3-64.0) | 6.4 / 25 (16-155) | 4.6 / 14 (14-34) | 0.35 | 0.66 | 0.90 |
| B2 | b | 3.38 (2.79-4.32) | 16.05 (12.15-17.08) | +2.8, +8.2, +4.9 | 22.7 (21.0-33.1) | 6.4 / 30 (30-37) | 4.3 / 11 (9-16) | 0.35 | 0.63 | 0.93 |
| B+rule | b | 4.87 (4.53-5.51) | 24.24 (16.83-27.78) | +11.0, +7.9, +20.6 | 50.0 (29.1-73.5) | 6.5 / 25 (25-53) | 5.3 / 14 (12-15) | 0.33 | 0.75 | 0.98 |
| B+budget | b | 6.80 (6.37-8.06) | 19.78 (16.77-21.57) | +8.3, +10.9, +9.6 | 27.1 (26.2-31.3) | 7.6 / 26 (24-42) | 5.9 / 16 (15-23) | 0.36 | 0.95 | 1.06 |
| B2+rule | b | 4.16 (3.82-4.46) | 13.62 (13.19-26.22) | +13.0, +4.7, +6.0 | 23.2 (16.8-56.7) | 6.1 / 31 (20-64) | 4.5 / 10 (10-26) | 0.34 | 0.73 | 0.99 |
| B2+budget | b | 7.06 (5.43-8.14) | 20.42 (17.66-20.51) | +7.2, +11.6, +10.4 | 25.4 (25.0-25.9) | 7.9 / 37 (25-50) | 5.8 / 12 (10-12) | 0.37 | 0.93 | 1.09 |

The busy shares and cores are medians; [results/tables.md](results/tables.md) has their ranges and a follower's cores. In the review GC-log hold the write p99s by run were: none 5.7, 7.1, 8.2; A 7.2, 7.9, 11.6 (+1.6, +0.9, +3.4); B 12.5, 14.1, 11.8 (+6.8, +7.0, +3.6); B2 11.9, 10.9, 9.9 (+6.3, +3.9, +1.7).

**The stall, 900,000 small rows** *(measured)*. Writes sent during the 5 s stall: about 250,000 in every run.

| Form | hold | answered before the stall ended | longest time with no answer | most writes waiting | the last stall write answered, after the stall ended | leader heartbeat timer, longest gap | followers: longest gap between leader messages |
|---|---|---|---|---|---|---|---|
| none | a | 100.0 % (99.9-100.0) | 17 ms (10-22) | 892 | 2 ms (0-2) | 101.4 ms | 11.3 ms |
| A | a | 0.0 % | 4,997 ms (4,996-4,997) | 250,271 | 1,790 ms (1,780-1,916) | 101.2 ms | 101.8 ms |
| M2, 64 MB / 2 MB | a | 0.0 % / 0.0 % | 4,998 / 4,999 ms | 250,325 / 250,287 | 1,569 / 1,914 ms | 101.1 / 101.1 ms | 101.5 / 101.1 ms |
| M1 | a | 32.9 %: plain 93.9 %, judged 0.0 % | 25 ms (22-26) | 167,982; 512 waiting after 12.6 ms (10.3-13.7) | 1,960 ms (1,728-1,991) | 102.2 ms | 17.2 ms |
| M3, 500 ms | a | 99.9 % (99.9-100.0) | 523 ms (517-551) | 26,828 | 2 ms (1-3) | 100.7 ms | 100.7 ms |
| M3, 200 ms | a | 99.9 % (99.9-100.0) | 226 ms (206-233) | 11,274 | 2 ms (1-2) | 100.4 ms | 100.3 ms |
| B | a | 99.9 % (99.8-99.9) | 19 ms (17-23) | 1,462 | 9 ms (5-10) | 105.1 ms | 21.9 ms |
| Bs | a | 99.9 % (99.8-99.9) | 23 ms (21-41) | 1,983 | 8 ms (3-11) | 107.9 ms | 28.8 ms |
| B2 | a | 99.9 % (99.8-100.0) | 18 ms (16-22) | 1,184 | 4 ms (1-5) | 103.7 ms | 14.5 ms |
| B | b | 99.9 % (99.8-99.9) | 26 ms (22-48) | 1,905 | 7 ms (5-7) | 104.7 ms | 25.8 ms |
| B2 | b | 99.9 % (99.9-99.9) | 15 ms (14-20) | 1,224 | 2 ms (2-4) | 102.7 ms | 13.8 ms |
| B+rule | b | 0.0 % | 5,000 ms | 260,001 | 3,627 ms (3,103-5,230) | **5,097.2 ms (5,011.6-5,101.2)** | **5,007.6 ms (5,005.1-5,007.6)** |
| B+budget | b | 99.8 % (99.5-100.0) | 16 ms (13-28) | 1,564 | 7 ms (2-12) | 103.8 ms | 18.0 ms |
| B2+rule | b | 0.0 % | 5,000 ms | 260,084 | 2,776 ms (2,581-2,985) | **5,012.7 ms (5,012.0-5,024.3)** | **5,003.5 ms (5,003.3-5,009.4)** |
| B2+budget | b | 99.8 % (99.7-100.0) | 35 ms (16-67) | 2,115 | 7 ms (2-9) | 106.2 ms | 17.0 ms |

- **The user rule's budget** *(measured, hold b)*. The budget cut the stalled call once in every run, after 9.2 to 10.2 ms where the run recorded it. It also cut turns with no stall in them: 1 to 3 a run in B+budget, 1 to 2 in B2+budget; the rule there costs a few µs, so those turns lost their 10 ms to something else on the box, such as a GC pause or the thread waiting for a core. Each cut refuses the one write whose rule was running, so 0 to 2 innocent writes a run were refused `rule-timeout` (the clients counted 2, 2, 2 and 3, 1, 2 refusals, the stalled write included). In all three runs of B+budget and in one of B2+budget the first cut came before the stall, so those runs did not record the stalled call's block; the longest silence bounds it.
- **1.5 times the rate** *(measured, hold b)*. At 75,000 writes a second the control's p99 was 10.15 ms (8.81-29.66). B's was 29.47 (21.03-62.02) and B2's 34.58 (19.63-109.63), up to 52 and 80 ms above the control, run by run. The worker's busy share was 0.82 (B) and 0.78 (B2). In the stall B answered 99.4 % (96.1-99.8), longest silence 46 ms (43-148); B2 99.9 % (99.8-99.9), 21 ms (20-25). So the worker keeps writes going at 1.5 times the rate, but its tail grows fast as the thread fills.
- **M3's hand-over** *(measured, hold a)*: with W = 500 ms the watchdog fired 485 to 498 ms into the stall, and the leadership, the new leader and the client's `moved` all followed within about 4 ms; the client resent 24,466 to 24,965 writes, which the new leader judged in a burst (p99 of writes sent after the move 140-238 ms). With W = 200 ms it fired at 184 to 210 ms. At 900,000 rows it never fired without a stall; at 1,000,000 rows, in one of three runs, it fired 3.1 s **before** the stall, at the table rebuild.

**1,000,000 small rows, the first holds** *(measured)*. Here the steady window held one table rebuild. The control's p99 was 9.92 ms (8.88-10.75); A 168.01 (140.36-441.28); M2 66.13 (53.08-98.04) and 107.74 (62.33-214.63); M1 84.38 (44.59-153.56); M3 106.74 (64.85-203.95) and 74.03 (44.59-145.60); B 251.72 (250.23-308.53); B2, in a later hold, 15.42 (13.54-20.20). In the untrimmed first runs every one of the 27 runs of A, M1, M2, M3 and B has a 100 ms bin about 9.7 s after the start in which fewer than half the writes were answered. B2's worker holds no `Map`, so its judging did not wait for the rebuild. The stall gave the same picture as at 900,000 rows: A and M2 0 %, M1 33.1 % (plain 94.6 %), M3 99.8 % (99.7-100.0) after one gap of 514-526 ms (W = 500 ms), B 100.0 % (99.9-100.0) and B2 99.9 % (99.9-100.0).

**2 KB rows, the first holds** *(measured)*: the stall gave the same picture (A and M2 0 %; M1 22.9 %, of plain writes 65.3 %; M3 99.8-99.9 % after one gap of 291 to 654 ms; B 99.3 % (98.7-99.9), longest silence 108-132 ms), except **B2: 62.5 % (62.4-70.9) answered, longest silence 483-568 ms**: its store rewrites a whole row as JSON on every field write, and its worker fell behind (p99 949 to 1,666 ms). The control's own p99 ran from 31 to 403 ms over its three runs, the shared disk setting the tail, so steady p99s on 2 KB rows say little.

**GC does not explain the tails** *(measured, the GC-log runs)*. On 900,000 rows the longest GC pause on the judging thread was 6.1-9.5 ms (A's main) and 7.3-7.7 ms (B's worker), and no pause on either leader thread passed 50 ms in any form. On 1,000,000 rows (the first GC-log hold) none passed 27 ms, yet A's main stopped for up to 244-330 ms and B's worker for up to 107-190 ms in those runs: the rebuild, not the collector. Run 3 of that hold broke for every form (the control's p99 was 623 ms, A's 643, B's 967, B2's 410), so it says nothing about the forms; the review repeated the GC log on 900,000 rows instead. On 2 KB rows none passed 38 ms on main; B's worker had two over 50 ms in one run (longest 64 ms).

**Side probes: the row work alone, one thread** *(measured)*. 50 writes of the mix a tick, 15,000 ticks run flat out, no I/O ([bench/spikes.mjs](bench/spikes.mjs)). The longest tick, ms, and where it came.

| Row store | rows | probe hold | longest tick, ms | ticks over 50 ms | the longest tick came at |
|---|---|---|---|---|---|
| a `Map` of row objects | 1,000,000 | first | 62.8 (56.5-125.6) | 1 | tick 9,689 in all three runs |
| a `Map` of keys to numbers (no row objects) | 1,000,000 | first | 55.3 (55.1-58.8) | 1 | tick 9,689 in all three |
| a `Map` of rows and a `Map` of versions (B's worker) | 1,000,000 | first | 111.3 (104.3-118.3) | 1 | tick 9,689 in all three |
| the same | 1,000,000 | second | 147.4 (130.1-151.6) | 1 | tick 9,689 in all three |
| the same | 900,000 | second | 25.9 (23.5-26.0) | 0 | ticks 1,565, 13,255 and 13,993 |
| the same, each `Map` cut into 256 (Bs) | 1,000,000 | second | 11.8 (11.2-12.3) | 0 | ticks 10,391, 10,394 and 11,850 |
| `data`'s lane (the fold) | 1,000,000 | first | 61.3 (59.1-81.0) | 1 (1-2) | tick 9,689 in all three |
| `data`'s lane and a `Map` of versions (main in A) | 1,000,000 | first | 112.0 (96.0-139.6) | 1 | tick 9,689 in all three |
| the same | 900,000 | second | 13.1 (12.7-14.0) | 0 | ticks 12,433, 12,431 and 4,591 |
| CompactRows (B2's worker) | 1,000,000 | first | 1.8 (1.7-1.8) | 0 | no long tick |
| the same | 1,000,000 | second | 2.1 (2.0-2.9) | 0 | no long tick |

The second probe then timed B2's upkeep, each step once as one block: moving its index (4,194,304 slots) into twice the slots took 99.3 ms (94.9-101.2), and copying its arena without the dead space (165 MB written, 11 MB of it dead) took 309.4 ms (308.3-328.3). Done in one go, either stops the worker as long as B's rebuild or longer, so B2's upkeep must go in small steps; that was not built.

**The cost of a budget** *(measured, [bench/budget.mjs](bench/budget.mjs))*: a one-line rule costs 0.027 µs a write called directly, 1.350 µs through one `vm` call a write, and **112.0 µs (106.5-112.1) through one `vm` call a write with a 10 ms timeout**: 5.6 cores at 50,000 writes a second. One `vm` call for each turn of 50 writes costs 1.085 µs a write with no timeout and 3.795 µs (3.711-3.950) with one: 0.19 of a core. A rule that never returns was cut after 10.4 ms at most.

**Memory a server** *(measured)*:

| Form | 900,000 small rows: worker heap / RSS after the load / RSS at the peak | 1,000,000 small rows: worker heap / RSS after / peak | 100,000 rows of 2 KB: worker heap / RSS after / peak |
|---|---|---|---|
| A | 11 / 489 / 1,032 MB | 10 / 523 / 1,191 MB | 10 / 400 / 1,443 MB |
| B | 307 / 839 / 1,579 MB (+296 / +350 / +547) | 334 / 901 / 1,858 MB (+324 / +378 / +667) | 230 / 664 / 1,774 MB (+220 / +264 / +331) |
| Bs | 307 / 860 / 1,614 MB (+296 / +371 / +582) | not run | not run |
| B2 | 11 / 723 / 1,058 MB (+0 / +234 / +26): 156 MB of rows written in the arena, 17 MB of it dead at the end | 11 / 773 / 1,220 MB (+1 / +250 / +29): 172 MB written, 17 MB dead | 11 / 663 / 2,240 MB (+1 / +263 / +797): 475 MB written, 254 MB dead |

Followers carry the same copy (their worker heaps match the leader's), so the B forms add this on every server. B2's store never frees space: its dead rows stay until a compaction that it does not have (the second probe times one).

**Checks** *(checked)*: in every one of the 150 runs all three servers' rows, and in the B forms every worker's copy, ended with the same digest, no fold refused a record, and every write was answered.

## What the numbers say

1. **Judging on main fails F-14 by construction, and the runs show it.** The worker kept the heartbeat (gaps of 101-103 ms) and committed what it already had, but every new write waited for main: 0 of about 250,000 answered in each 5 s stall, then 1.8 to 1.9 s more to drain at 900,000 rows. Replication and failure detection were never stalled, so the record's own words ("never stalls replication or failure detection") hold; its test ("a 5 s main-thread stall keeps writes going") does not.
2. **Judging on the worker meets F-14 for a stall on main, and moves the problem to user rules.** B, Bs and B2 answered 99.9 % of stall writes, with a longest silence of 14 to 48 ms. But in B every user rule runs on the kernel thread, and a rule that loops stopped that thread for the whole 5 s: no answers, no heartbeat, nothing to the followers. In a real group the followers would elect a new leader after their timeout, so writes would come back after a failover, much as M3's hand-over does *(reasoned)*. A `vm` budget for each turn fixes that, at a cost: about 0.3 of a core more on the worker (busy 0.66 for B, 0.75 with the rule, 0.95 with the rule under a budget), and turns with no stall cut when they lose 10 ms to the box. A budget for each write costs about 112 µs a write, 5.6 cores at 50,000 writes a second, more than the box has; a budget for each turn costs 3.8 µs a write, so the budget must cover a turn.
3. **P-01 does not separate the threads.** Without a rebuild in the window, judging on main (A) and judging off the heap on the worker (B2) added about the same to the control's p99 (A +0.9 to +10.2 ms over six runs in two holds, B2 +1.7 to +8.8 over nine runs in three), and B's `Map` copy a little more (+3.6 to +33.0). The control itself is above the bar. So the case for the worker is F-14 alone.
4. **A table rebuild stops the thread that owns the table.** At 1,000,000 rows each big `Map` filled its table about 9.7 s into the run, and every thread that judged from a `Map` stopped there: A's main (with `data`'s rows and the versions) and B's worker (its copy). B2's worker, with no `Map`, did not. The probe puts numbers on it: B's two `Map`s stopped their thread for 130 to 152 ms at the rebuild, and `data`'s lane with the versions for 96 to 140 ms; cut into 256 `Map`s, B's copy stopped for 11 to 12 ms at most, and B2's store for 2.0 to 2.9 ms. But B2's own upkeep, done as one block, stops its thread for 95 to 101 ms (the index) or 308 to 328 ms (the arena). It happens once each time a table fills: here about 220 s later again, when removed entries fill the new table *(reasoned)*. Over a long window one stop of about 0.1 s every 220 s delays about 5,000 to 10,000 of 11,000,000 writes, so it moves p99.9 and not p99 *(reasoned)*. It does not depend on the thread: `data`'s own store rebuilds on main in every form, so reads and live links on main feel it.
5. **A GC flag does not help.** A 64 MB young generation and a 2 MB one changed A's p99 by a few ms either way at 900,000 rows, and neither touched a stall of user code.
6. **Splitting writes (M1) keeps only the plain ones.** Plain writes kept going in the stall (93.9 %) at the control's latency, but every conditional write, op and field write stopped, and with them every plain write to the same row. With fero's client cap of 512 waiting writes, a client is full 10 to 14 ms into the stall, and then its plain writes stop too.
7. **A watchdog (M3) moves writes to a healthy peer after one gap of W.** With W = 500 ms the gap was 0.52 to 0.55 s; with 200 ms, 0.21 to 0.23 s. But 200 ms is shorter than a table rebuild on main at 1,000,000 rows, and there it fired once with no stall. The writes resent to the new leader arrive as one burst (about 24,500 at W = 500 ms) that its main must judge at once. M3 changes nothing in steady load. On one server, or a group with one voter, it has no peer to move to *(reasoned)*.
8. **The worker's margin depends on a free core.** At 50,000 writes a second B's worker was busy 0.66 of the time, B2's 0.63, and 0.93 to 0.95 with the budget. At 75,000 writes a second B's worker was busy 0.82 and its p99 rose to 21-62 ms; one run answered only 96.1 % in the stall.
9. **The second copy costs every server** about 230 to 380 MB per million small rows after the load (B2 to B), and at the peak B costs 550 to 670 MB more than A while B2 costs about 30 MB more. B2's store has no compaction, so its dead space grows: 17 MB in a run at small rows, 254 MB at 2 KB rows.

## Rules each form needs

Counted LAYERS' way: a rule counts when a builder must write it and dropping it, or getting it wrong, breaks a stated property (SIMPLICITY 1.2). The base is LAYERS as written, which is form A; these are the rules each form adds or moves. Every count is *reasoned*; where a run showed what dropping one does, the row says so.

| Form | Rule | + | How known |
|---|---|---|---|
| A | none: LAYERS 3.4's reading as written | 0 | |
| M2 | none: a V8 flag on the server's process | 0 | |
| M1 | `plain-direct`: the worker appends a plain write itself only when no write of its row waits at main (a count per row, raised when a write goes to main, lowered when its result comes back) | 1 | reasoned: without it a plain set can land before an earlier `incr` of the same row, which then adds to the wrong value |
| M1 | `plain-notice`: in the same turn, main's overlay takes every write the worker appended, in arrival order, before its entry can commit | 1 | reasoned; the runs check the two together (every copy ended equal) |
| M1 | the session table moves to the worker, which must dedup the writes it appends; one table for both paths | 0 to 1 | reasoned |
| M1 | the key check of the shape rule (`__proto__`) runs on the worker too | 0 to 1 | reasoned |
| M1 | the client's 512-write cap counts plain and judged writes apart, or judged writes are refused early while main is stalled; else the cap fills with stuck judged writes and plain writes stop too | 1 | measured: 512 waiting 10 to 14 ms into the stall; the rule was not built |
| M3 | `main-watch`: every worker pings its main every 20 ms; a leader whose main has not answered for W hands its leaderships over | 1 | measured |
| M3 | `no-lead-stalled`: a server whose main has not answered for W refuses a leadership (a transfer, an election, a hand-back), and a follower's answers tell the leader whether its main is healthy | 1 | reasoned: a first build without it handed the leadership back to the stalled server within milliseconds, but that run's log is not kept in results/ |
| M3 | the hand-over itself: wait until the appended tail commits, transfer to a healthy follower that holds every entry, tell clients `moved`; with no such follower within W, lead on | 0 to 1 | Raft's leadership transfer is in the base (rolls; E-53's hand-back); the waits are new or part of it |
| M3 | a deposed leader drops the results its main sends late, and its session table forgets attempts it judged but never appended | 0 to 1 | `writer-judging` already says a deposed writer answers `unknown`; the forgetting is new |
| M3 | the hand-back once main answers again; the client's resend after `moved` | 0 | in the base (E-53; `ack-stages`: the client resends after a failover) |
| B, Bs, B2 | `judge-copy`: every server keeps a second copy of its rows on the kernel worker, since any copy may lead and a new leader must judge at once (F-05); the leader moves its judged rows into it at commit, a follower decodes each committed entry a second time | 1 | measured (memory, CPU) |
| B, Bs, B2 | `copy-check`: the worker's copy is checked against `data`'s rows (F-21's digest, on both threads of every copy). RR-17 as written allows the worker only an index or a cache checked this way, never one that judges | 0 to 1 | checked at the end of every run here; on a schedule in a build |
| B, Bs, B2 | `copy-bytes`: the leader's copy takes the values it judged, so a judged value must survive encode and decode (PA-12's guard), or the leader's copy reads the committed bytes as a follower's does | 0 to 1 | reasoned |
| B, Bs, B2 | `rule-budget`: user code that judges runs on the kernel thread, so under a time budget **for each turn** (one `vm` call with a timeout for the whole turn; the write whose rule ran over is refused and the turn's later writes run again), with a quarantine for a rule that keeps timing out; and a write cut by the budget is run again alone before it is refused, since a turn can lose its time to the box | 2 to 3 | measured: without it a rule that loops stops the kernel thread, heartbeats included (B+rule, B2+rule); a budget for each write costs about 112 µs a write against 3.8 µs for each turn (the budget probe), so it must cover a turn; a 10 ms budget for each turn cut 1 to 3 turns of ordinary writes a run. The run-again was not built |
| B, Bs, B2 | that code is loaded on the worker by its hash | 0 to 1 | reasoned |
| B, Bs, B2 | no single hash table of a million keys on the judging thread: the copy is cut into many tables (Bs) or kept off the V8 heap with upkeep in small steps (B2) | 0 to 1 | measured in the probe: B's two `Map`s stopped their thread for 130 to 152 ms at the rebuild, the same cut into 256 for 11 to 12 ms, B2's store for 2.0 to 2.9 ms; but B2's own upkeep as one block stops it for 95 to 328 ms. The upkeep of B2's store is code, not protocol |

Sums: **A 0, M2 0, M1 +3 to +5, M3 +2 to +4, B, Bs and B2 +3 to +8.** B2's store (an arena and an index in typed arrays) is code, not protocol, and adds no rule of its own.

## Verdict

**Judge on the kernel worker, with user rules under a budget for each turn, on a copy of the rows that keeps the kernel thread free of long blocks; the reason is F-14, not P-01.** Judging on main (A), as LAYERS 3.4 reads the design rule, fails the kill row: a 5 s main-thread stall answered 0 writes, in every run. The cheap middle forms do not rescue it: a GC flag (M2) changes neither result; appending plain writes from the worker (M1) keeps only plain writes; a watchdog hand-over (M3) passes F-14 only if one pause of about W (0.52-0.55 s at W = 500 ms) counts as "keeps writes going". Judging on the worker passed F-14 for a stall on main (B, Bs, B2: 99.9 %, longest silence 14-48 ms), and for a stall in a user rule only with a budget (99.8 %, 13-67 ms); without one, the kernel thread and its heartbeat stopped for 5 s. P-01 is met by no form on this box, the control included (p99 5.7-13.2 ms at 900,000 rows), and against the control A and B2 add about the same. With the fewest rules, M3 meets F-14 on the loose reading (+2 to +4); on the strict reading only the worker does (+3 to +8). Owed: a row store for the worker that neither rebuilds one big table (B) nor falls behind on big rows (B2's JSON arena), with its upkeep in small steps; a budget that does not cut innocent turns; and a referee ruling, since RR-17 as written lets the worker keep only an index or a cache, never one that judges.

LAYERS 10 item 1 and 3.6: the kill row fired; judging on main fails F-14 (0 of about 250,000 writes in a 5 s stall) but not, on this harness, P-01 any more than the worker does (above the no-judging control at 900,000 rows: A +0.9 to +10.2 ms, B2 +1.7 to +8.8, B +3.6 to +33.0; the control itself 5.7-13.2 ms); judging on the worker meets F-14 for a stall on main (99.9 %), and for a stall in a user rule only under a `vm` budget for each turn (99.8 %; without it 0 % and no heartbeat for 5 s); a watchdog hand-over meets F-14 after one pause of 0.52-0.55 s (W = 500 ms). Moves: LAYERS 3.4's reading (judge on main) down on F-14; DESIGN-V5 4.3's placement (judge on the kernel thread) up, on the condition of a budget for each turn, a row store with no single million-key table, and a referee ruling on RR-17; P-01 neutral between the threads; COMP2's F-14 stays met only with the worker (or with M3 on the loose reading).

## What the review found, and what changed

A review checked the first version of this page: it reran quick mode, three cells at 1,000,000 rows, cells at 900,000 rows, and two side probes, each three times under the timing lock. Each finding below was checked again here before anything changed, and the review holds ran after the changes.

| # | Finding | Holds? | How it was checked here | What changed |
|---|---|---|---|---|
| 1 | The long steady tails at 1,000,000 rows are one `Map` table rebuild about 9.7 s into each run, inside the 10 s steady window | yes *(measured)* | In the untrimmed first runs, every one of the 27 runs of A, M1, M2, M3 and B at 1,000,000 rows has a 100 ms bin at 9.7 s with fewer than half its writes answered. The side probe's longest tick is tick 9,689 in every run of every `Map`-based store. `data`'s store keeps its keys in one `Map` (`keySlot`) | P-01 is now read at 900,000 rows, where no rebuild falls in the run (review holds a and b, and a GC-log hold). The 1,000,000-row numbers stay, labelled "one table rebuild in the window". "Now and then" is now "once each time a table fills" |
| 2 | Without the rebuild, A adds the least on P-01, and B2 is not the only form near the floor | yes, in part *(measured)* | Hold a: A +4.1 to +10.2 ms, B2 +4.0 to +8.8, B +8.2 to +9.8; the GC-log hold: A +0.9 to +3.4, B2 +1.7 to +6.3, B +3.6 to +7.0 | A and B2 cost about the same on P-01, and B a little more; A is not clearly the least. The P-01 column, the short answer and the verdict are rewritten: the case for the worker is F-14 alone |
| 3 | "The worker's copy must not be a heap of JavaScript objects" does not follow; one big hash table is the cause | yes *(measured)* | The second probe: B's two `Map`s at 1,000,000 rows stopped their thread for 130 to 152 ms, at tick 9,689; the same cut into 256 `Map`s for 11 to 12 ms, with no tick over 50 ms; the two `Map`s at 900,000 rows for 23.5 to 26.0 ms. In the full runs at 900,000 rows Bs was no better than B (p99 18.35 against 16.22 ms), as there was no rebuild to avoid | The claim is now "no single hash table of a million keys on the judging thread" |
| 4 | B2's index was sized up front and never grows; its arena is never compacted | yes *(checked: the code; measured: the probe)* | `CompactRows` sizes its index at 4,194,304 slots for 1,000,000 rows and has no code to grow it. The second probe adds both steps and times them as one block each: moving the index into twice the slots took 95 to 101 ms, and copying the arena without its 11 MB of dead space 308 to 328 ms | The upkeep is listed as owed beside B2, with its block time |
| 5 | "B2 4 to 9 ms above the control, run by run" paired runs from different holds; run 3 of the 1,000,000-row GC-log hold broke for every form | yes *(checked)* | The first B2 runs at 1,000,000 rows ran in a later hold than the control's. In the GC-log hold run 3 the control's p99 was 623 ms | Every review hold carries the control; the tables pair run i with the control's run i in the same hold and give each run's p99. The broken run is named, not used; the GC log was run again on 900,000 rows |
| 6 | "B meets F-14" holds only for app code on main: a rule that loops on the worker stops the kernel thread, and a `vm` budget a write costs about 100 µs | yes *(measured)* | B+rule and B2+rule: 0 % answered, heartbeat gap 5.0-5.1 s. B+budget and B2+budget: 99.8 %. The budget probe: 106 to 112 µs a write with a budget for each write, 3.7 to 4.0 µs with one for each turn | B's F-14 is split in two: a stall on main, and a stall in a user rule. `rule-budget` is now measured and counts a turn's budget and the run-again of a cut write; the sums rise from +3 to +7 to +3 to +8 |
| 7 | B's margin depends on spare cores | yes *(measured)* | Each thread's busy share; none, B and B2 at 75,000 writes a second in hold b | Busy shares and the 1.5 times rate are in the tables and in "What the numbers say" 8 |
| 8 | The judge is a stand-in, and B judges on its own copy | yes *(checked: the code)* | | Said in Limits |
| 9 | The load has P-01's rate but not its shape | yes *(reasoned)* | | Said in "How it was measured" and in Limits |
| 10 | Memory was given after the load only | yes *(checked)* | | A peak column, and B2's dead space |
| 11 | "+334 MB of worker heap" is B's whole worker heap; the increase is +324 MB (+220 MB at 2 KB rows) | yes *(checked)* | | fixed |
| 12 | The base RSS at 2 KB rows is A's 400 MB, not 396 MB | yes *(checked)* | | fixed: B +264 MB, B2 +263 MB |
| 13 | M1's rules add up to +3 to +5, not +2 to +5 | yes *(checked)* | | fixed |
| 14 | Mixed numbers (0.23-1.15 s, ≤ 116 ms, 34-98 ms) and `no-lead-stalled` marked checked on a build not in results/ | yes *(checked)* | | fixed; `no-lead-stalled` is now reasoned |
| 15 | Quick mode rewrote `results/versions.txt` | yes *(checked: run.sh)* | | quick mode writes its versions to the scratch folder |

One more thing turned up while fixing these: the budget cut turns that held no stall (1 to 3 a run), so a 10 ms wall-clock budget refuses an innocent write now and then *(measured)*. That is why `rule-budget` now runs a cut write again alone before it refuses it.

## Limits

- **A stand-in for the kernel.** No Raft election, no snapshot, no restart, no relay, no TLS, one group. The commit rule, the journal and the answer at commit are real; E-10's Raft port is not inside. PATHS B11 found the real port costs more per write than E-02's pipeline, so every form's latency here is a floor *(reasoned)*.
- **A stand-in judge.** Only A's row read is `data`'s (`node.get`). The condition (`if: { equals }`) and `incr` are a few lines in [bench/common.mjs](bench/common.mjs), not fero's or `data`'s condition and op code, and the B forms judge on their own copy, not on `data`'s store. Both threads run the same stand-in, so the comparison is fair, but its cost is a floor *(checked: the code)*.
- **P-01's rate, not P-01's shape.** 50,000 writes a second is P-01's rate. But a million rows with 5,000 new keys a second is E-07's stress shape; P-01's own example holds a few rows. That shape is what put a table rebuild in the first holds' window. With few rows no table is big enough for its rebuild to matter *(reasoned)*.
- **The table rebuild comes on a schedule.** At this mix every big `Map` fills about 9.7 s after a run on 1,000,000 rows starts, then about every 220 s. The review reads P-01 at 900,000 rows, between rebuilds; over a long window one rebuild moves p99.9 and not p99 *(reasoned)*.
- **The box's own floor is above the bar.** A client, three servers and their journals share 4 vCPUs and one disk; the control that judges nothing already has a p99 above 5.73 ms. P-01's absolute bar is not testable here; the forms are compared with the control in the same hold, run by run, and the spread between holds (A +0.9 to +10.2 ms) is as large as the gaps between forms.
- **Main does only the fold and the judging.** A real server's main thread also runs the app, `data`'s views and taps, subscribers and served views. Each adds to what every write waits on in A, M1, M2 and M3, and to nothing on the B forms' write path *(reasoned)*. So A's numbers here are the best A can do.
- **The user rule is a stand-in.** It accepts every write and reads the clock once a call (for the stall's start), so its own cost is small; a real rule costs more on whichever thread runs it. No user code ran in any form but the +rule and +budget ones.
- **One client link, one session, JSON `ASK`s.** A real client sends fero's codec; the judge's decode cost differs (PATHS: 2.7-3.2 µs a small row in v4's codec). Both judging threads pay the same decode here.
- **B2's store is a first build.** It keeps rows as JSON text and rewrites the whole row on every write. In the full runs its index was sized up front and never grew, and its arena was never compacted; the second probe times both steps once, as one block each. A binary store that patches fields in place and does its upkeep in small steps was not built, so B2's failure on 2 KB rows is this store's, not the worker's *(reasoned)*.
- **Two stall kinds.** A 5 s busy loop on main (F-14's test), and in the +rule and +budget forms a 5 s busy loop inside one call of the user rule. A long GC on main (E-07: up to 0.98 s while loading 5e6 small rows) stops judging the same way in A, M1, M2 and M3, and fires M3's watchdog when it passes W *(reasoned)*.
- **The hand-over ran once per run, to a healthy peer.** The hand-back after main recovers, a server that leads many groups, and every server stalling at once were not run.
- **Rule counts are reasoned.** No model checked any form's rules; the runs check only that every copy ends with the same rows.
- **Trimmed results.** [results/runs.jsonl](results/runs.jsonl) keeps every run's line without its 100 ms timelines (`bins`); the bin-by-bin check of finding 1 used the untrimmed lines.

## Open questions for the owner

1. **F-14's wording.** Does one pause of about a hand-over (here 0.52-0.55 s with W = 500 ms) during a 5 s main-thread stall count as "keeps writes going"? If yes, M3 meets F-14 with the fewest rules (+2 to +4) and judging can stay on main; if no, only judging on the worker does.
2. **RR-17.** May the kernel worker judge on its own copy of the rows, checked against `data`'s rows by F-21's digest? RR-17 as written allows only an index or a cache; the owner's later answer on DATA-01 (VERDICT 11.6, the loose reading) seems to allow it once DATA-09's differential test holds, but no ruling says so.
3. **Memory.** Is a second copy of the rows on every server acceptable (about 230-380 MB per million small rows after the load here, and up to 670 MB more at the peak for B) against DEP-13's small copies?
4. **P-01's runner.** This box's floor without any judging is above 5.73 ms at p99. Should P-01's pin be judged on a quieter, larger runner, or against a no-judging control on the same box?
5. **The rule budget.** A wall-clock budget cut innocent turns here. Should the budget count the rule's own CPU time, or run a cut write again alone, or both?

## How to run

```sh
SP=<your scratch folder> ./run.sh quick      # every cell once, 100,000 small rows, a 2 s stall; heavy lock; tables to the screen
SP=<your scratch folder> ./run.sh full       # every hold (first holds, side probe, review holds), then results/tables.md
SP=<your scratch folder> ./run.sh review     # only the review holds (900,000 rows: a, b, the GC log) and the second probe
SP=<your scratch folder> ./run.sh hold 900000 small [cell ...]   # one hold: runs 1 to 3 of the cells
SP=<your scratch folder> ./run.sh gchold 900000 small            # the GC-log runs for one row set
SP=<your scratch folder> ./run.sh spikes2    # the second side probe and the budget probe
SP=<your scratch folder> ./run.sh summary    # results/tables.md from the results already there
```

`SP` holds the lock helpers `bin/timing` (runs a command alone on the box) and `bin/heavy` (shares it and waits for timing runs). `NODE` defaults to `node` on PATH (Node 22.22.0). `DATA` is `data`'s folder for [tree.sh](tree.sh) (default `../data` next to this repo, read only). Nothing is downloaded. A cell is `form[@W][/rate]:[leader flag]`, as `CELLS`, `CELLS_A` and `CELLS_B` in [run.sh](run.sh) list them; `WATCH_MS` sets M3's W, `RATE` the rate, and `GCSTATS=1` turns on the GC log for [bench/run.mjs](bench/run.mjs).
