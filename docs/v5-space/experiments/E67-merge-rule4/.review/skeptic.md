# E-67: second skeptic pass

2026-11-23. A review of the rebuilt E-67. First it checks that the first review's findings (S1 to S6, N1 to N7) are in. Then it tries to refute the rest. Marks are as in the README: *(measured)*, *(checked)*, *(counted)*, *(reasoned)*.

## In short

- **The first review is folded in.** All 13 findings are handled (table below).
- **The numbers match.** Every number I checked in the README and in results/summary.md matches results/sim.jsonl and results/bench.jsonl *(counted)*. A rerun of g4 / none (1,000 seeds) gave the same line as sim.jsonl, field for field, except the run time *(checked)*. Quick mode reran clean.
- **The main claims stand for takeovers.** The bug is real, (a) passes, b0 fails, (c) passes, giving up fails, and every planted bug fails on answers in both worlds.
- **One blocking finding (B1).** A rebuild gets its floor from the merger that died. One probe shows it matters.
- **The pick (a) stands.** Several findings make (a) look better than the README says; none make it worse.

## The first review: folded in?

| Finding | In? | Where |
|---|---|---|
| S1 a rebuild revived down hosts | yes | outages stay through a rebuild; the gap is reported (section 6) |
| S2 the closure is rule 2's | yes | `noclosure` and `nojoin` split, each with failures in seeds with no case; the rule table splits rule 4 from rule 2 (sections 3, 7) |
| S3 two takeover costs left out | yes | named in the pick; the install timed at 1, 4 and 16 groups (section 4) |
| S4 the ring's top 10 is the prototype's | yes | marked, and scaled to a fold's cost (section 4) |
| S5 every copy keeps the rows | yes | wording fixed; the planted bug `droprows` fails 114 and 569 |
| S6 the three-commit move; waits in sim steps | yes | sections 4 and 10, and "in these worlds' sim steps" in the answer |
| N1 groups removed | yes | counted when removed (792) |
| N2 shared fault draws; few no-case seeds in stress | yes | stated in section 10 |
| N3 checks between full checks | yes | stated; a full check now comes every 25 joins, not every 500 applies |
| N4 health shares helpers | yes | the health oracle reads the world's move table; the join bugs skip health |
| N5 the queue is the inbound buffer | yes | Words |
| N6 giving up in one form only | yes | `giveupskip` added (193 and 574) |
| N7 the ring keeps objects | yes | an encoded column in the ring bench |

## Blocking

### B1. A rebuild's floor comes from the merger that died

**What.** At a rebuild, each picture names the halves after the old merger's place. The intake keeps each group's place through `rebuild()`, and the sim's picture starts its halves there. In (c), the copies also know at once every move that any merger closed (`oldClosed` in sim.mjs). A merger that crashed cannot hand over its places. The README does not say where a real new merger gets them.

**The probe** ([floor-probe.mjs](floor-probe.mjs), results in [probe.jsonl](probe.jsonl)). It copies sim.mjs and lowers each rebuild picture's floor to an older cut of the dead merger, taken from its last 64 served cuts. 1,000 seeds a line.
- **One older cut, the same for every group** (`stale`): (a) failed 0 of 1,000 in g4 and in stress *(checked)*. 3,488 and 41,142 rebuild pictures got a lower floor and carried 1,092 and 48,906 extra halves *(counted)*.
- **Each group its own older cut** (`mixed`, as when each host keeps only the last place the merger acked to it): (a) failed 96 (g4) and 735 (stress) of 1,000 seeds. Every one was "stuck: pictures that cannot be installed" *(checked)*.
  - Why: A's picture names a fence whose open at B lies below B's floor. B's picture does not name that open, and no frame will bring it. So the fence waits for ever *(reasoned from intake.mjs, `needs`)*.
- **(c) with `mixed`** failed 0 of 1,000 in stress, since a fence never waits *(checked)*.
  - But (c) leans on the exact set of closed moves. Say a copy names a part for a move the old merger already closed. The new merger installs it, and the move's close lies below the floor, so the merger never sees it. Those rows then count twice *(reasoned; not run)*.

**Why blocking.** Section 0 item 2 counts 9,061 rebuilds for (a). But the rule table and the MERGE.md text in section 8 have no rule for where the floor comes from, and (a) wedges without one.

**Fix.**
- **Add the rule:** a new merger starts every picture from one cut of the old merger.
  - Example: the merger sends its whole cut with its acks; each host keeps the last one; the new merger picks one cut and tells every host before the pictures.
  - The per-group minimum of whole cuts is also a cut *(reasoned)*.
  - The same cut tells (c) which move parts are still open.
- **Count it:** (a) +4 to +5, (b) +5 to +6, (c) +6 to +7, and MERGE's net about +11 to +17 *(reasoned)*.
- **Fold in the probe** as a planted bug (`mixed` floors), state (c)'s closed-set need, and name the rule in section 6 and in owner question 1.

## Should-fix

### F1. Many "stuck" failures are wedges, mostly from moves with no rows

**Under O1's rules.** 40 failing seeds had no rule-4 case with rows: 11, 21, 6 and 2 (g4, g16, elastic, stress; `failedNoCase` in sim.jsonl). The probe reran g4 and g16 at the exact floor and got the same lines. All 32 of those seeds failed as "stuck" *(checked)*.
- So claim 1, "every failing seed had a picture that passed a half", holds only when a half with no rows counts.
- That point is worth stating. A passed half with no rows changes no answer, but it still wedges the merger: the fence waits for a partner it can never see. So rule 4 must carry halves with no rows too.
- Section 9 says "a passed half with no rows changes no answer". It should add "but it still wedges the merger".

**In the planted bugs, "stuck" is a big share** (g4 / stress) *(counted)*: `nojoin` 25 of 97 and 348 of 727; `giveup` 43 of 221 and 214 of 611; `giveupskip` 14 of 193 and 161 of 574.
- These come from the intake's bookkeeping. Once a half's partner is taken out of turn, a fence's `needs` looks only at `closeOf`, which was deleted at the close. It does not look at `closed`, so the fence waits for ever. With rows, the same seeds fail on answers first *(reasoned from the code)*.
- So part of each count measures how this intake wedges, not what the planted rule does to answers.
- Counting answer failures alone, each bug still fails clearly: `nojoin` 72 and 379, `giveup` 178 and 397, `giveupskip` 179 and 413.

**Two definitions.** The "no case" columns count a picture past any half. The Words define the case with rows. Under the Words' definition, `nojoin` had 3 failures with no case and `rebuildnol` had 2, so "only in seeds that had the case" is not quite right.

**Fix.**
- In tables 1 and 3, report answer failures and "stuck" apart.
- Use one definition of the case, or say "any half, with rows or not" where that is what is meant.
- Add the wedge point to section 9 and to the rule-4 text.

### F2. The frozen part's cost rests on the prototype partial too

The pick's first takeover cost is 27.6 ms to 7.84 s. Most of it is building O1's six-view partial: 5.26 to 7.14 s of the 5.92 to 7.84 s at 1e6 rows, about 5 to 7 µs a row *(measured, summary.md section 7)*. The README marks (b)'s top-10 figure as the prototype's (S4), but not this one. At one fold's 0.63 to 1.5 µs a row, the build would take about 0.6 to 1.5 s at 1e6 rows *(reasoned)*.

**Fix.** Mark it the same way, with the same scale. The pick does not change.

### F3. The ring's coverage is a property of the sim's rate

The 96.3 to 100 % coverage rests on one commit a step across all groups. In stress, a 140-step outage is about 17 commits a group.
- At 50,000 writes a second per leader, 64 frames are about 1.3 ms of commits, if a frame is one commit *(arithmetic)*. A failover takes far longer than that to notice.
- So in real time a ring of 64 would rarely reach back, and (b) would nearly always fall back to (a)'s picture *(reasoned)*.
- Section 4 says "in the worlds here". Section 0 item 4 does not.

**Fix.** Say it in item 4 and in section 4, with the arithmetic and the batch caveat: frames per commit batch would stretch the ring. This makes the case for (a) stronger.

### F4. In (c), each fence sends the moving rows to the merger

In intake.mjs, (c) builds the move part from the fence's rows (`new Partial('m' + mv)` and `takeRows(rows)`). So each fence must carry the slots' rows, or a picture of them, to the merger, on every move and not only at a takeover.
- That is up to 830 KB for a 64-slot move at 1e6 rows and 4,096 slots, and about four times that at the sim's 1,024 slots *(counted; reasoned)*.
- The merger then holds a part made of rows while the move is open.
- The README names what the copies keep, but neither this link cost nor the change to "the merger never holds rows".

**Fix.** Name both in sections 4 and 7. They bear on (c) as the fallback.

## Nits

- **N1.** Section 0 item 7 is marked *(checked)*. But the gap follows from the sim's own rule that a new merger serves only once it has every part. Mark the gap *(counted)* and "cannot keep serving" *(reasoned)*, as section 6 does.
- **N2.** "About the same at 1, 4 and 16 groups": at 1e6 rows only 1 and 4 groups were timed (the bench skips n × G above 4e6). And 4 groups is up to 1.6 times slower: 215 to 397 ms, against 174 to 252. Say "1 and 4" at 1e6.
- **N3.** The move-part bench uses 4,096 slots; the sim uses 1,024 (`SLOTS` in lib). README table 5 should say "of 4,096".
- **N4.** The six-view ring row in summary.md: its resend applies only the sums and window parts of each frame (the resend loop in bench.mjs), so its resend times are too low. Label the row or drop it. Also, the sums partial holds no state, yet it costs 0.65 to 0.84 µs a record at 1e6 rows against 0.20 to 0.36 at 1e5. The 1e6 run has 50,000 records against 200,000, and its rows are spread over a larger heap. The top of "20 to 84 ms" comes from that run.
- **N5.** The ring at 256 frames in stress repeats the 64-frame line, since 64 already covered 100 %. Run the size sweep in elastic instead, where 64 missed 254 takeovers.
- **N6.** Rule counts. "+4 in (c) less the pairing" reads as +3; it is +4 with the pairing's −1 already in it. Also say whether keys kept apart replaces E-23's "each key from exactly one group" in MERGE's count. If O1's +7 counted that rule, keys kept apart is a swap, and the net is one lower.
- **N7.** The world never draws a new host behind the merger's place. O1's "the new host waits until it is at or past the merger's place" is assumed here, not run. The intake has no way out of a picture behind its place: it waits for ever ('behind'). State it as a limit.

## What I checked

**Counts** *(counted)*:
- section 0 items 1 to 9;
- tables 1 to 5 and summary.md sections 1 to 7;
- the four-world totals: 2,066,979 checks, 93,389 moves, 46,257 takeovers, 7,395 outages, 9,061 rebuilds of which 2,313 during an outage, 11,765 case pictures, 354,490 health checks;
- the gap means 60.4 (at most 409) and 15.9 steps;
- held 174,546 and 72,974; frozen 75,703 and 493; 2,504 pictures with several halves;
- the ring arithmetic (20 to 84 ms, 0.72 to 2.12 s, 63 to 150 ms);
- the rule totals;
- the planted-bug table and its no-case columns. `summarize.mjs` reads the right fields: the no-case columns are `failedNoAnyCase`.

**The copies.** src/lib.mjs and src/partial.mjs differ from E-64 O1 only in a header line and the import path. merger.mjs differs as its header says.

**Reruns:**
- quick mode;
- g4 / none (1,000 seeds), identical to sim.jsonl;
- the probe at the exact floor, which reproduces g4 / none (366) and g16 / none (114) with the same failure kinds. So the probe's changes alter nothing else.

**The probe:** 7 lines of 1,000 seeds: (a) `stale` and `mixed` in g4 and stress, (c) `mixed` in stress, and the two exact lines above. `node floor-probe.mjs` makes `probe-sim.mjs` from `../sim/sim.mjs`, which then runs as sim.mjs does, with `--floor=exact|stale|mixed`.
