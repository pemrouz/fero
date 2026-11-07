# E-14b: membership on commit, finished (the real CommunityModules jar, the liveness sweep, the healing scenarios, the mutants)

**Question (Q-14, completion addendum).** E-14 asked: are membership changes that take effect on commit, as in etcd's raft, safe and live in fero's healing scenarios? It left four things open: its liveness sweep at 3 to 4 servers did not finish; five healing scenarios were defined but not run; the DEV-10 mutants ran only in random simulation; and local stand-ins replaced the TLA+ CommunityModules jar. E-14b closes these. Threshold (Q-14's own): on commit, every invariant and the liveness property hold at 3 to 4 servers, 2 changes, terms up to 4, each run up to 1 hour, and on append gives the stuck trace.

**Status: partial** (2026-11-07). Done: the jar check; the reductions' calibration; the liveness sweep for the R2-1 shape (`four-voters`, complete), two voters (`two-1c1f`, `two`), growth from one voter (`one-noq`), three voters with a crash, R2-1; the lost-disk ghost; learners refusing votes; 18 of 22 mutants exhaustively. Not finished: liveness for `three-disk` (a lost disk replaced by a spare id) and `four` (the swap), both stopped or not run for time; r19 inconclusive; r15, r16 and the r15 flip not run (equivalent by E-14's reading); r20 caught only by E-14's script.

## In short

- **The real jar changes nothing.** With CommunityModules release 202611060952, all five E-14 runs that finished give the same states and verdicts as with E-14's stand-ins. The jar's Java `FoldBag` has the stand-in's argument order. Side finding: the jar's own TLA+ text has the other order, and TLC fails on etcd's spec with it. So etcd's spec runs only thanks to that Java override.
- **The liveness check now finishes at Q-14's bounds** for most scenarios: four stated reductions (two exact; two that leave out some message delays, checked on four pairs that finish both ways) and checkpointed segments. The R2-1 shape from a working leader (4 voters, demote one, one crash) is complete: 5,165,341 states.
- **On commit, with the campaign guard, broke no real safety property in any run** (committed logs always agreed), and is **live from three voters up**: no stuck state with a live majority in `four-voters`, three voters with a crash, or R2-1 with and without a crash. On append stays stuck at R2-1.
- **New: one stuck case on commit.** Growing from two voters to three, if the leader is lost after the promotion commits and before the other voter hears of it, the survivors (a majority of the new configuration) wait for the old leader to come back; if its disk is lost, they need an operator step. On append does not stall there (measured). etcd's code behaves the same as the model (read).
- **Two more rules shown necessary**: learners must vote (with learners refusing, 12 more stuck states), and a lost disk must never return under its old id (if it does, a committed entry is lost in 34 steps). DESIGN-V5 §4.1's disk incarnation id already gives the second.
- **Mutants by exhaustive search**: 11 of 22 mutants caught (10 by exhaustive search here, r20 by E-14's script), 11 of the 13 that are not equivalent by reading (85%), against E-14's 6 of 22 in random simulation; r19 is open.
- **Two TLC traps**, for anyone who splits TLC runs: `stopAfter` prints "Model checking completed" even with states left, and `-recover` does not restore the fingerprint function, so every segment must name the same `-fp`. Both cost a run here and are fixed and documented.
- **Two of etcd's eight shipped invariants are stronger than Raft needs** once configurations differ between servers: `QuorumLogInv` fires on a lagging learner, and `LeaderCompletenessInv` fires on a stale leader of an older term. Neither firing here was a real loss: `one-noq` checks the first over a whole space; the second (in `three-disk` on commit and `four-voters-append`) is reasoned from the traces, with the invariants TLC checks before it holding, and it stopped both runs before their liveness verdicts.

## Words used here

- A **voter** counts toward commits and elections. A **learner** copies the log but does not count.
- **On commit** (etcd's rule, the design): a server acts on a configuration only once the entry holding it is committed and the server has applied it. **On append** (the mutant): a server acts on the last configuration entry in its log, committed or not.
- **The campaign guard**: a server does not stand for election while a committed configuration change is not yet applied (etcd's `hup`). E-14 found that "on commit" is safe only with it. Every on-commit run here has it.
- **Working leader** (E-14's goal): a leader that is a voter of its own applied configuration and has committed an entry of its own term. **Plan done** (new here): a working leader whose configuration is the scenario's healing target (for example, after a swap: the learner promoted and the chosen voter gone).
- **Stuck**: from this state, with no more faults and no recoveries, no path reaches a working leader. **Live majority**: a majority of the voters of the latest committed configuration (as any server not lost for good knows it) is up.
- **AG EF** ("from every reachable state, the goal can still be reached"): healing.py's P5, "no stuck state with a live majority". E-14 checks it on TLC's own state graph with a small tool; so does E-14b ([tools/agef2.py](tools/agef2.py)).
- **TLC**: the TLA+ model checker. It visits every state the model can reach within the bounds.
- A **reduction** leaves out some orders of steps so the search finishes. Each one here is stated, with why it keeps the verdicts, and checked against the model without it on runs small enough to finish both ways.
- **DEV-10** (REQUIREMENTS): mutants are made by script from the model text (drop each guard, drop each update, flip each comparison), never hand-picked. A mutant is **caught** when the checker finds a counterexample with it.

## Method

### The model and the reductions

E-14's model at 3 to 4 servers, with a working leader making changes and one crash, reached over a million states in 25 minutes and did not finish. Sampling 100,000 states of one such run showed why: 97% had a message in flight, and 46% had a message older than its receiver's term ([results/three-1c-rb-interrupted.txt](results/three-1c-rb-interrupted.txt)). Most states were the same few situations with messages at different points of their trip. E-14b adds four reductions in [tla/MCferolive.tla](tla/MCferolive.tla). It `EXTENDS` E-14's MCferoraft.tla unchanged (which `EXTENDS` etcd's etcdraft.tla unchanged), so every rule, fault, goal and invariant is E-14's; only the next-state relation leaves some orders out.

| Id | Reduction | What it leaves out | Why the verdicts stay (reasoned) |
|---|---|---|---|
| R1 | **EagerReady**: etcd's `Ready` step (persist, then release the messages) is taken at once. While an up server has unpersisted state or unsent messages, the only step is its `Ready`. | states where a server's `Ready` waits while others act; crashes between a step and its `Ready` | `Ready(i)` touches only i's disk record and i's outgoing messages; no other step reads them, and it stays enabled until taken. So it commutes with every other server's step. A crash before `Ready` loses exactly what the step did (the log tail, the term, the messages), the same as a crash before the step. One case is left out: a message released after its receiver crashed, kept in the network, and delivered after the receiver recovers (a delayed message; see R4). |
| R2 | **BatchVote**: a candidate sends its vote request to every member it has no answer from, in one step. | states where a candidate has asked some members and not yet others | The request is fixed for the candidate's term (its log cannot change while it is a candidate), so this is the shipped `RequestVote(i, j)` steps taken back to back. Checked against the shipped action's text (self-vote included). |
| R3 | **DeadView**: TLC tells states apart by a view that blanks variables no step reads before they are written again: the vote sets of a server that is not a candidate, the match indexes and sent-commit marks of a server that is not a leader. | nothing: states that differ only in dead variables are merged | Only a timeout makes a server a candidate, and it clears its vote sets (the spec's own comment on `HandleRequestVoteResponse` says late tallies "won't be looked at"); becoming leader resets match indexes; a sent-commit mark from an older term never equals a new term's. No invariant and no goal reads them. Two states with the same view have the same futures, so this is exact. |
| R4 | **EagerNet**: while a message to an up server is in the network, the only step (after R1) is to deliver one, in any order. | states where a message waits while other servers act, crash or recover: delayed messages | A coarsening, not exact. In this crash-only model (no message loss, no partitions, `LeaderLease`), a message that waits and then arrives stale is rejected, which equals never sending it; and a sender can still crash between sends to different followers, so a leader's entry can still reach some and not others (R2-1's shape is reached). Checked against the model without it on runs that finish both ways (below). |

**What a PASS means under these reductions.** Every reduced step is one or more steps of the full model, and the reductions only remove choices. So when the reduced graph shows a path from a state to the goal, the full model has that path too. A reduced PASS is therefore sound for every state it visits; what it can miss is a stuck state that only the left-out orders reach. That coverage loss is what the calibration runs measure. A reduced FAIL could be a false alarm (the full model may have a way out the reduced one lacks); every FAIL here is checked by hand against its trace.

**E-14's reductions, kept**: `InitLeader` (start once the first leader has committed), `CoarseAE` (a leader sends a follower everything it lacks in one append, and no idle heartbeats), `LeaderLease` (a follower stands only when no up server leads in its term or a later one, which is what PreVote with CheckQuorum gives without partitions), no duplicate sends or replies (duplication is a fault of its own), a view that ignores responses older than their receiver's term, terms bounded with judging only at terms two below the bound, healing plans that restrict which changes a leader proposes, never when, and symmetry among interchangeable members.

### The two goals

[tools/agef2.py](tools/agef2.py) reads TLC's state graph (dumped with `-dump dot,actionlabels` through a pipe into [tools/dotfilter.py](tools/dotfilter.py), which keeps a few flags per state and the edges) and checks two things from every judged state:
1. **E-14's goal** (healing.py's P5): with a live majority, steps that are neither faults nor recoveries can still reach a working leader.
2. **The plan goal** (new; healing.py's P8 in its simplest form): from every judged state with no fault used and a live majority, steps can still reach a working leader whose configuration is the scenario's healing target. It is judged only where no fault has happened, so no proposal can have been lost and the change budget is enough.

A state is judged when its highest term is at least two below the term bound, so every judged state has two more elections in hand. Both checks are sound under TLC's symmetry reduction because the goals, the flags and the step kinds are symmetric (E-14's argument).

### Runs longer than one hold

A run longer than one hold of the heavy lock is cut into segments. TLC writes a checkpoint every few minutes (`-checkpoint`), stops itself at the hold's deadline (`-Dtlc2.TLC.stopAfter`), and the next segment, in a new hold, resumes from the last checkpoint (`-recover`). Each segment writes its own graph file; agef2.py reads them together (states written twice, after the checkpoint and before the stop, are merged). [tools/segtest.py](tools/segtest.py) checks this machinery: one run in one piece against the same run cut into short segments. Two traps, both found here and fixed:
1. When `stopAfter` stops TLC, it still prints "Model checking completed. No error has been found." So a run is complete only when that line comes with an empty queue ([tools/common.py](tools/common.py)). The first `four-voters` attempt was misjudged this way; its partial result was discarded.
2. TLC picks its fingerprint function (`-fp`) at random in every process, and `-recover` does not restore it. So, unless every segment names the same `-fp`, a state carried across a checkpoint gets a new id in the next segment: TLC explores it again (safety checking stays complete, with some states counted twice), but the graph's edges no longer meet at the joins, and states there look stuck. The second `four-voters` attempt (terms up to 5, five segments, `fp` 76, 48, 80, 37, 33) hit this: 471,666 edge ends with no node, and a false "1,026,546 stuck states". Now every segment runs with `-fp 7`, and [tools/agef2.py](tools/agef2.py) marks a graph INVALID when any edge end has no node. The evidence for the fix (model-checked here):
- without `-fp`: [tools/segtest.py](tools/segtest.py) on `three-1c1f`, in one piece and cut into 150-second segments, gives 555,676 states in one piece and 574,478 when cut, different node ids, and a false FAIL with 282 stuck states ([results/segtest-nofp.txt](results/segtest-nofp.txt));
- with `-fp 7`: `four-voters` joined four segments with no dangling edge (5,165,341 states); and `three-1c1f` cut into nine segments over two holds ended at exactly the one-piece count, 555,676 states ([results/segtest-fp7-resumed.txt](results/segtest-fp7-resumed.txt); its graph comparison is void, because a bug in the test tool, since fixed, deleted the first segments' graphs before the comparison). A clean rerun of the fixed test (`segtest.py two-1c1f 25`, about 5 minutes) was queued at the end but did not get the box before this report, as timing runs held it; `./run.sh calib` runs it.

Two runs were affected, `four-voters` at terms up to 5 and `r21f-rb`; their liveness results are discarded and both were re-run (`four-voters` at terms up to 4, like every other sweep run); their safety results stand, since every state was explored and checked.

### The mutants

[tools/mutex.py](tools/mutex.py) takes E-14's 22 mutants as E-14's own generator makes them ([../E14-membership-on-commit/tools/mutants.py](../E14-membership-on-commit/tools/mutants.py), unchanged): each tagged guard dropped, each tagged update dropped, each comparison flipped, over the 20 tagged rule lines of fero's membership rules. Each mutant runs, exhaustively, on small scenarios, cheapest first, until one catches it: a broken invariant, a stuck state where the design has none, or a healing plan that cannot finish where the design's can. The design runs the same scenarios first and must pass all of them.

## Results

Machine: 4 vCPU, 15 GB, one virtual disk, shared with other agents (load 3 to 12 during these runs); Java 21, TLC2 2026.11.06 nightly, `-workers 2`, Python 3.13 with numpy 2.5 ([results/versions.txt](results/versions.txt)). Wall times include sharing the CPU. Raw TLC output (trimmed) is in [results/](results); every run's constants are in [cfg/](cfg); the tables below are built from [results/runs.json](results/runs.json) by [tools/table.py](tools/table.py).

### Step 1: the real CommunityModules jar

E-14 could not fetch the TLA+ CommunityModules and wrote three small stand-ins (`SequencesExt`, `FiniteSetsExt`, `BagsExt`) for the eight operators etcd's spec uses. E-14b fetched the real jar, release `202611060952` (2026-11-06) from the tlaplus/CommunityModules GitHub releases (sha256 in [fetch.sh](fetch.sh) and [results/versions.txt](results/versions.txt); GitHub lists no checksum, so these were recorded on first download). [tools/jarcheck.py](tools/jarcheck.py) re-ran every finished E-14 run with E-14's own `.cfg`, with the jar on TLC's classpath and with the stand-ins, and two more ways: the jar's own TLA+ text with no Java overrides (`jartext`), and the same with E-14's `BagsExt` in place of the jar's (`jartext-bagstub`). Model-checked here ([results/jarcheck.md](results/jarcheck.md)):

| run | module set | distinct states | depth | queue left | verdict | wall s |
|---|---|---|---|---|---|---|
| staleconfig | jar | 172 | 64 | 0 | violates MoreThanOneLeaderInv | 3 |
| staleconfig | stubs | 172 | 64 | 0 | violates MoreThanOneLeaderInv | 4 |
| stale2 | jar | 51 | 34 | 0 | complete, no violation | 6 |
| stale2 | stubs | 51 | 34 | 0 | complete, no violation | 7 |
| stale2 | jartext | 4 | 4 | 0 | TLC error: Error: TLC threw an unexpected exception. | 2458 (mostly waiting for the lock) |
| stale2 | jartext-bagstub | 51 | 34 | 0 | complete, no violation | 4 |
| stale2-mutant | jar | 71 | 54 | 0 | violates MoreThanOneLeaderInv | 4 |
| stale2-mutant | stubs | 71 | 54 | 0 | violates MoreThanOneLeaderInv | 4 |
| r21-script | jar | 79 | 73 | 0 | violates NotGoal | 4 |
| r21-script | stubs | 79 | 73 | 0 | violates NotGoal | 4 |
| r21-append-ef | jar | 2905 | 22 | 0 | complete, no violation | 15 |
| r21-append-ef | stubs | 2905 | 22 | 0 | complete, no violation | 11 |
| r21-append-ef | jartext | 14 | 4 | 9 | TLC error: Error: TLC threw an unexpected exception. | 4 |
| r21-append-ef | jartext-bagstub | 2905 | 22 | 0 | complete, no violation | 13 |
| shipped-asis | jar | 1097543 | 12 | 786181 | stopped at cap | 283 |
| shipped-asis | stubs | 779930 | 12 | 557978 | stopped at cap | 282 |

`jar` is CommunityModules-deps.jar on TLC's classpath (its TLA+ text and its Java overrides); `stubs` is E-14's stand-ins; `jartext` is the jar's TLA+ text with no Java overrides; `jartext-bagstub` is the same with E-14's `BagsExt`. `shipped-asis` is etcd's own `MCetcdraft.cfg`, which never finishes (E-14's F4): each set ran 5 minutes, so its counts measure throughput on a shared box, not a difference in meaning.

**Every verdict and every state count is the same with the jar and with the stand-ins.**

**FoldBag's argument order** (read from the jar, and model-checked). etcd's spec calls `FoldBag(LAMBDA x, y: IF y.msource = i THEN BagAdd(x, y) ELSE x, EmptyBag, pendingMessages)`, so it needs `op(accumulator, element)`, once per copy. The jar has two definitions of `FoldBag`:
- its Java override (`tlc2.overrides.BagsExt.foldBag`, read with `javap -c`), which TLC uses whenever the jar is on the classpath: it keeps the accumulator in the first argument and applies `op(acc, element)` once per copy. That is exactly E-14's stand-in.
- its TLA+ text (`BagsExt.tla`, through `Folds.MapThenFoldSet`), which folds `op(f(x), acc)` across elements: the other order. With etcd's operator, TLC then fails at the fourth state: "Attempted to apply function `<<>>` to argument "msource"" ([results/jarcheck/stale2-jartext.txt](results/jarcheck/stale2-jartext.txt)). With E-14's `BagsExt` swapped in for that one module, the jar's text gives the jar's numbers exactly.

So E-14's stand-ins match what TLC really evaluates, and no E-14 verdict changes. A side finding: etcd's spec only runs because of the jar's Java override; a tool that reads the TLA+ text alone (TLC without the jar's classes, Apalache, TLAPS) would not evaluate `PendingMessages` as TLC does (model-checked here for TLC; reasoned for the others).

### Step 2: the reductions against the model without them

Each pair below is the same scenario with and without a reduction, run to completion both ways (model-checked here; full rows in [results/tables.md](results/tables.md)):

| Scenario | Rule | Without | States | With | States | Verdicts |
|---|---|---|---|---|---|---|
| R2-1 state, no fault (`r21-append-none`, `-rb`, `r21-append`) | on append | none | 2,905 (E-14's exact count) | R1+R2; R1 to R4 | 135; 135 | all three: the R2-1 state stuck, nothing else judged |
| R2-1 state, no fault (`r21-rb`, `r21`) | on commit | R1+R2 | 91,576 | R1 to R4 | 3,603 | both: no stuck state, the plan finishes |
| R2-1 state, one more crash (`r21f-rb`, `r21f`) | on commit | R1+R2 | 1,143,532 | R1 to R4 | 25,175 | both: no stuck state among the 5 judged states (those before any new election), the plan finishes |
| three voters, one change of any kind, no fault (`three-1c-rbd`, `three-1c`) | on commit | R1+R2+R3 | 2,698,102 (21 min) | R1 to R4 | 12,098 (7 s) | both: no stuck state among 10,736 and 2,464 judged states; the plan finishes |

What this shows. R1+R2 reproduce E-14's model exactly where E-14 finished (`r21-append-none` gives E-14's 2,905 states). R4 (EagerNet), the one coarsening, removes 96 to 99.6% of the states and changed no verdict in any pair that finishes both ways. A pair with a fault and a working leader making changes (`two-1c1f` without R4, about 13 million states by the ratio above) does not fit this shared box; `r21f` is the fault pair that does. So R4's coverage is checked on fault-free scenarios and one small fault scenario, and argued for the rest (the table under Method).

The same ratio is why R4 is needed at all: without it, even three voters with one change and no fault take 21 minutes; with one crash added, the run with R4 grows 46 times (12,098 to 555,676 states, `three-1c1f`), so without R4 it would not finish in hours.


### Step 3: the liveness sweep and the healing scenarios

Every sweep run: crashes as the fault (at most one; a recovery is free but is not a progress step), `LeaderLease`, no message loss, the scenario's healing plan, terms up to 4 (Q-14's own bound; judged at 2 or lower, so every judged state has two elections in hand), all four reductions, `-fp 7`. Per scenario (model-checked here; full rows in [results/tables.md](results/tables.md)):

| Scenario (what healing does) | Run | Rule | Finished | Distinct states | Invariants | Stuck with a live majority (judged states) | Plan finishes |
|---|---|---|---|---|---|---|---|
| **R2-1's shape**: 4 voters; the leader demotes or removes one; one crash anywhere | `four-voters` | on commit | yes, 4 segments, 92 min | 5,165,341 | all 8 hold | **0** (18,414) | yes (4,090 judged) |
| the same at terms up to 5 (first attempt) | `four-voters-t5` | on commit | yes, 5 segments | 5,685,029, some counted twice (mixed `-fp`) | all 8 hold | not valid (graph broken at the joins) | not valid |
| the same, on append | `four-voters-append` | on append | stopped at a broken invariant, 60 steps | 677,790 | `LeaderCompletenessInv` broken (a stale leader; see below) | not reached | not reached |
| R2-1's state itself; and with one more crash | `r21`; `r21f` | on commit | yes | 3,603; 25,175 | all hold | 0 (1); 0 (5) | yes |
| R2-1's state, on append | `r21-append` | on append | yes | 135 | all hold | **1**: the R2-1 state itself | no |
| three voters, any one change, one crash | `three-1c1f` | on commit | yes | 555,676 | all hold | 0 (9,024) | yes |
| **two voters and a learner** (heal back to three, or step back to one), one change, one crash | `two-1c1f` | on commit | yes | 64,245 | all hold | **4** (2,090): the two-voter window | yes |
| the same, two changes | `two` | on commit | yes | 558,605 | all hold | **6** (17,014): the two-voter window | yes |
| the same (one change), on append | `two-1c1f-append` | on append | yes | 79,641 | all hold | 0 (3,273) | yes |
| the same (one change), learners refuse votes | `two-1c1f-novote` | on commit, R6 off | yes | 59,775 | all hold | **16** (2,090): 4 two-voter window, 12 a refused learner vote | yes |
| **growth from one voter**: 1 voter and 2 learners, promote both, one crash | `one` | on commit | stopped at a broken invariant | 111,597 | `QuorumLogInvLive` broken (too strong; see below) | not reached | not reached |
| the same, without that one invariant | `one-noq` | on commit | yes | 190,058 | the other 7 hold | **88** (14,816): the two-voter window, on the second promotion | yes |
| **a lost disk, replaced by a spare id**: 3 voters and a spare; add the spare, remove a voter; one crash or lost disk | `three-disk` | on commit | stopped at a broken invariant, 2 segments, 66 steps | 2,736,260 | `LeaderCompletenessInv` broken by a stale leader (see below); the six invariants TLC checks before it, including "committed logs agree", held in every state | not reached | not reached |
| **a lost disk that returns under its old id** (any one change) | `three-ghost` | on commit, ghost | stopped at a broken invariant, 16 steps | 4,019 | `QuorumLogInvLive` broken | not reached | not reached |
| the same, without that invariant | `three-ghost-loss` | on commit, ghost | stopped at a broken invariant, 34 steps | 54,270 | `MoreUpToDateCorrectInv` broken: the new leader lacks a committed entry, which is then lost | not reached | not reached |
| **the swap**: 3 voters and a learner; promote the learner, demote a voter | `four` | on commit | not run: it grows like `four-voters` and the time was spent there | | | | |

#### The new finding: growing from two voters to three, the group waits for the old leader

`two-1c1f` (on commit, the campaign guard on; two voters s1 and s2 and a learner s3; the plan "demote a voter or promote the learner"; one change; one crash; terms up to 4) has 4 stuck states with a live majority, all after the crash ([results/two-1c1f.txt](results/two-1c1f.txt), shortest trace 16 states):
1. Leader s1 appends "promote s3" (voters s1, s2, s3) and sends it to s2.
2. s2 stores it and acks. s1 now has both votes of the old configuration {s1, s2}, so the change is **committed**. s1 knows; s2 does not yet (s1 has not sent it the new commit index).
3. s1 crashes. s2 and s3 are up: 2 of the 3 voters of the committed configuration.
4. s2 still acts on {s1, s2}: it has not applied the promotion, because it does not know it is committed. It may stand, but its tally counts only s1 and s2, so it cannot win without s1. s3 is a learner in its own configuration and may not stand. Nothing moves until s1 comes back.

This is not an artifact of the reductions: every step of the trace is a step of the full model, and in the stuck state no message is in flight and the only enabled steps are s2's timeouts and s3's vote, which cannot help (reasoned). It is not only in the spec either: etcd's code does the same, since `promotable()` (raft.go line 1938) and the vote tally `poll()` → `r.trk.TallyVotes()` (line 1082) read the applied tracker, which changes only in `applyConfChange`/`switchToConfig` (lines 1943, 1971) (read here at commit c51f010).

On append, s2 would act on {s1, s2, s3} as soon as it stored the entry and win with s3's vote. Measured: the same scenario on append (`two-1c1f-append`) has no stuck state (79,641 states, complete).

Which changes have this window (reasoned): after a change from an old configuration of n voters commits, the survivors of a lost leader still act on the old configuration until they hear the commit. They can elect a leader if n − 1 is a majority of n, which holds for n ≥ 3 and fails for n ≤ 2. For n = 1 nobody can go on under either rule. So **only the step from two voters to three** is less live on commit than on append. The window is one message long (the leader's next append carries the commit index). With a crash, the group waits until the old leader returns. If the old leader's disk is lost, the group waits for ever and needs an operator step; E-14's live-majority test does not count that case (the only member that knew of the commit is gone), but the survivors could go on safely, as on append would.


#### Learners must vote (R6), shown by ablation

With learners refusing votes (`two-1c1f-novote`, R6 = FALSE), the same scenario has 16 stuck states instead of 4. A trace to each ([results/two-1c1f-novote-traces.txt](results/two-1c1f-novote-traces.txt), made by [tools/traces.py](tools/traces.py)): in 4 of them s2 does not know the promotion committed (the two-voter window above); in the other 12, s2 knows it and has applied {s1, s2, s3}, but s3 has not yet, still sees itself as a learner, and refuses s2's vote request. With learners voting (etcd's rule: "learners must be allowed to cast votes"), s3 grants it and s2 wins. So "learners vote" is a rule the design needs: one more in DEV-10's count, already in etcd's code.

#### `QuorumLogInvLive` is too strong for on commit

`one` breaks `QuorumLogInvLive` after 64 steps ([results/one-trace.txt](results/one-trace.txt), compact; TLC's output in [results/one.txt](results/one.txt)). In the last state, s1 (down) committed both promotions; s2 leads in term 3 with {s1, s2, s3} applied; s3 has commit index 5 but has applied nothing yet, so its own configuration is still the genesis one, voters {s1}. The invariant (E-14's copy of the shipped `QuorumLogInv`, counting only disks that exist) asks that every quorum of *each server's own applied configuration* hold that server's committed log; the quorum {s1} of s3's stale configuration lacks the newest entry, so it fires. That configuration is never used to elect anyone: s3 is a learner in it, and the campaign guard stops every server from standing while it has a committed change unapplied. Run without that one invariant (`one-noq`), the whole space finishes (190,058 states) and the other seven invariants, which include leader completeness and log matching, hold in every state. So the violation is the invariant's strength, not a safety bug. The shipped spec applies configurations the same way (`ApplySimpleConfChange` jumps to the latest committed one), so its own `QuorumLogInv` can fire the same way on a learner two changes behind (reasoned, not run on the shipped spec).

#### A lost disk must not return under its old id

`three-ghost` (GhostReturn: a lost disk comes back at once, empty, under its old id) breaks `QuorumLogInvLive` after 16 steps ([results/three-ghost.txt](results/three-ghost.txt)): leader s1 appends "demote s1"; s2 stores it and acks; s2 loses its disk and returns empty as s2; s1 counts the earlier ack and commits. Now a quorum of the new configuration ({s2, s3}) holds no copy of a committed entry. Run without that invariant (`three-ghost-loss`), TLC breaks `MoreUpToDateCorrectInv` after 34 steps ([results/three-ghost-loss-trace.txt](results/three-ghost-loss-trace.txt); the first run's trace is [results/three-ghost-trace.txt](results/three-ghost-trace.txt)): s2 wins term 3 with the vote of the empty ghost s3, and its log lacks the committed demotion entry; its own term-3 entry sits at the same index, so when it replicates, it overwrites s1's committed copy. A committed entry is lost. So a member that lost its disk must come back under a new id, never its old one. DESIGN-V5 §4.1 already has this rule (a random disk incarnation id: "a new or wiped disk can never repeat an old one, so it can never vote as the replica it replaced"); `three-ghost` shows it is needed, so it counts as a rule in DEV-10's sense.

#### A stale leader breaks a shipped invariant, on append (`four-voters-append`) and on commit (`three-disk`)

`four-voters-append` breaks `LeaderCompletenessInv` after 60 steps ([results/four-voters-append-trace.txt](results/four-voters-append-trace.txt), compact; model-checked): s1, leader of term 2, appends "demote s2" (voters s1, s3, s4) and crashes before sending it; on append, s1 already acts on {s1, s3, s4}. s2 stands for term 3 and s3 and s4 vote for it. Before s2 counts those votes, s1 recovers, stands for term 4 under {s1, s3, s4}, wins with s3 and s4, and commits the demotion and its empty entry with s1 and s3 (2 of 3). Only then does s2 count its old term-3 votes and become leader of term 3, without the demotion entry, which the invariant (a leader whose term is above a committed entry's term must hold it) forbids.

That leader of term 3 cannot commit anything: s1, s3 and s4 are all at term 4. And the same shape (a candidate that counts old votes after a later term has committed) is reachable in plain Raft whenever two candidacies overlap. The model's bound "one candidate at a time" counts candidates in the timing-out server's own configuration: on commit, s1's configuration still holds s2 and blocks s1's candidacy; on append it no longer does. So this is the shipped invariant being stronger than Raft's real property, met through that bound, not a shown on-append safety bug (reasoned from the trace). Its liveness verdict was not reached. On append's known failure stays R2-1 (`r21-append`, stuck).

`three-disk` (on commit) stops the same way after 66 steps ([results/three-disk-trace.txt](results/three-disk-trace.txt)): s1 commits "remove s2" (voters {s1, s3}) and appends "remove s1" (voters {s3}), then crashes; s2, which does not know the first change committed, stands for term 3 and gets s3's vote; s1 recovers and, acting on its applied {s1, s3}, which no longer holds s2, may stand while s2 is still a candidate; it wins term 4 with s3 and commits both entries; then s2 counts its term-3 votes and leads term 3 without them. Again that leader cannot commit (s1 and s3 are at term 4), and TLC checks the invariants in order and stops at the first false one, so the six before `LeaderCompletenessInv` (committed logs agree on every server, one leader per term, log matching, the quorum and up-to-date checks) held in that state too. A fix for the model, not for fero: the invariant should only bind leaders whose term is above the term in which the entry was committed. With the time left, neither run was repeated without that invariant, so their liveness verdicts are open.


### Step 4: DEV-10's mutants by exhaustive search

E-14's 22 mutants (its own generator, unchanged) ran through [tools/mutex.py](tools/mutex.py), each to completion on these scenarios, cheapest first, stopping at the first that catches it (model-checked here; [results/mutants-exhaustive.md](results/mutants-exhaustive.md) and [.json](results/mutants-exhaustive.json); full TLC logs in the scratchpad):

| Scenario | What | The design on it |
|---|---|---|
| `m3` | three voters, any one change, no fault, terms up to 4 (with no fault, an election happens only when a leader's own change removes it) | 12,098 states; nothing broken, no stuck state, the plan finishes |
| `m2` | two voters and a learner, any two changes, no fault | 100,736 states; the same |
| `m2p` | two voters and a learner, the healing plan (demote a voter or promote the learner), one change, no fault: the plan goal catches a change that never takes effect | 572 states; the same |
| `m3c` | three voters, any one change, one crash of the leader | 500,230 states; the same |
| `m4c` | four voters, demote one, one crash of the leader | not used: the design run did not finish in 15 minutes (691,952 states) |

| mutant | rule line | verdict | where |
|---|---|---|---|
| FeroBecomeLeader:drop-guard:r01 | `/\ votesGranted[i] \cap GetConfig(i) \in Quorum(GetConfig(i))` | **caught** | m3: MoreUpToDateCorrectInv; 891 states explored |
| FeroBecomeLeader:drop-update-pendingConfChangeIndex:r02 | `/\ pendingConfChangeIndex' = [pendingConfChangeIndex EXCEPT ![i] = Len(log[i])]` | **caught** | m2: QuorumLogInvLive; 48,753 states explored |
| FeroBecomeLeader:drop-update-log:r03 | `/\ log' = [log EXCEPT ![i] = Append(@, [term \|-> currentTerm[i], type \|-> ValueEntry, value \|-> Noop])]` | **caught** | m3: stuck with a live majority (416 states); 5,698 states explored |
| ProposeConf:drop-guard:r04 | `/\ state[i] = Leader` | **caught** | m3: ElectionSafetyInv; 7 states explored |
| ProposeConf:drop-guard:r05 | `/\ pendingConfChangeIndex[i] <= commitIndex[i]` | **caught** | m2: QuorumLogInvLive; 15,779 states explored |
| ProposeConf:flip-<=-to-<:r05 | `/\ pendingConfChangeIndex[i] <= commitIndex[i]` | not caught | on m2, m2p, m3, m3c |
| ProposeConf:drop-guard:r06 | `/\ ConfApplied(i)` | **caught** | m2: QuorumLogInvLive; 4,557 states explored |
| ProposeConf:drop-guard:r07 | `/\ newVoters # {}` | not caught | on m2, m2p, m3, m3c |
| ProposeConf:drop-update-log:r08 | `/\ log' = [log EXCEPT ![i] = Append(@, [term \|-> currentTerm[i], type \|-> ConfigEntry, value \|-> [newconf \|-> newVoters, learners \|-> newLearners]])]` | **caught** | m2p: plan cannot finish (40 states); 40 states explored |
| ProposeConf:drop-update-pendingConfChangeIndex:r09 | `/\ pendingConfChangeIndex' = [pendingConfChangeIndex EXCEPT ![i] = Len(log'[i])]` | **caught** | m2: QuorumLogInvLive; 17,365 states explored |
| AddLearnerF:drop-guard:r10 | `/\ j \notin GetConfig(i) \cup GetLearners(i)` | not caught | on m2, m2p, m3, m3c |
| AddVoterF:drop-guard:r11 | `/\ j \notin GetConfig(i) \cup GetLearners(i)` | not caught | on m2, m2p, m3, m3c |
| PromoteF:drop-guard:r12 | `/\ j \in GetLearners(i)` | not caught | on m2, m2p, m3, m3c |
| DemoteF:drop-guard:r13 | `/\ j \in GetConfig(i)` | not caught | on m2, m2p, m3, m3c |
| RemoveF:drop-guard:r14 | `/\ j \in GetConfig(i) \cup GetLearners(i)` | not caught | on m2, m3; not run on m2p, m3c |
| FeroApplyConf:drop-guard:r15 | `/\ LastConfIdx(log[i], commitIndex[i]) > 0` | not run | |
| FeroApplyConf:flip->-to->=:r15 | `/\ LastConfIdx(log[i], commitIndex[i]) > 0` | not run | |
| FeroApplyConf:drop-guard:r16 | `/\ ~ConfApplied(i)` | not run | |
| FeroApplyConf:drop-update-config:r17 | `/\ config' = [config EXCEPT ![i] = CommittedConf(i)]` | **caught** | m3: stuck with a live majority (628 states); 5,376 states explored |
| FeroApplyConf:drop-update-state:r18 | `/\ state' = [state EXCEPT ![i] = IF state[i] = Leader /\ i \notin CommittedConf(i).jointConfig[1] THEN Follower ELSE state[i]]` | **caught** | m3: stuck with a live majority (728 states); 2,776 states explored |
| CanCampaign:drop-guard:r19 | `/\ i \in GetConfig(i)` | not caught | on m2p, m3; not run on m2, m3c |
| CanCampaign:drop-guard:r20 | `/\ ConfApplied(i)` | not run here exhaustively (no time left); **caught by E-14's script** | `stale2-mutant`: two leaders in one term, re-run here with the real jar (step 1) |

| | Count | Which |
|---|---|---|
| caught by exhaustive search here | 10 | r01 (tally counts voters only), r02 and r03 (the new leader's pending index and empty entry: Ongaro's fix, caught by smaller patterns than his five-server trace), r04 (only a leader proposes), r05, r06 and r09 (one change at a time), r08 (the change is appended), r17 (the configuration is applied), r18 (a removed leader steps down) |
| caught by E-14's script, re-run here | 1 | r20 (the campaign guard) |
| not caught, and equivalent by E-14's reading | 6 run, 3 not run | run on all four scenarios: the r05 flip, r10, r11, r12, r13; on two: r14. Not run: r15, its flip, r16 |
| not caught, outside the property by construction | 1 | r07 (no empty voter set): its only effect is a configuration with no voters, and the live-majority test needs a non-empty one |
| inconclusive | 1 | r19 (only voters stand): not caught on `m3` and `m2p`; on `m2` and `m3c` it blows the state space up (1.49 million states in 15 minutes on `m2`, against 100,736 for the design) and did not finish |

**Score: 11 of 22 caught (50%); 11 of the 13 that are not equivalent by reading (85%)**, against E-14's 6 of 22 and 6 of 13 in random simulation. DEV-03's bar (≥ 85% of one-rule mutants) is met only when the equivalent mutants are left out of the count, and r19 is open.

**Rules counted (DEV-10 (c), ablation).** Shown necessary here: the 11 caught rules above; learners vote (R6, by ablation in `two-1c1f-novote`); a lost disk never returns under its old id (`three-ghost`, `three-ghost-loss`); and on commit itself against on append (R2-1). That is 14 rules for membership on etcd's raft, all already in etcd's code or in DESIGN-V5 (§4.1's disk incarnation id): no new mechanism.

## What this box cannot show

- **A full check without reductions at Q-14's bounds.** Three voters, one change and no fault already take 2.7 million states and 21 minutes without R4; with one crash the reduced run grows 46 times, so the unreduced one would take many hours. Every sweep verdict rests on R1 to R4, and R4 (the one coarsening) is checked only on the pairs in step 2.
- **Bigger bounds**: 5 servers (Ongaro's 2015 single-server bug needs 5, so r02 and r03 are caught here by smaller patterns, not by his trace), more than 2 changes, more than one fault per run, partitions as such, message loss together with liveness. One fault per run is a model bound, not a claim about real failure patterns.
- **The bigger healing scenarios at full size.** `four` (3 voters and a learner, the swap) and the lost-disk scenario `three-disk` grow like `four-voters` (millions of states); see the sweep table for how far each got.
- **Fairness**: AG EF says a way out exists from every state; that random election timeouts take it with probability 1 is reasoned, not checked.
- **Timing**: how long the two-voter window lasts in practice (one append round trip after the commit) is not measured here; E-13 and E-38 measure etcd's timings on this box.
- **Run time**: the box was shared with other agents throughout (load 3 to 12), so wall times are not comparable between runs, and the "each run up to 1 hour" bar is met only in CPU terms for some runs (`four-voters` took 92 minutes of wall time over four holds).

## Against the threshold

Q-14's threshold: "on commit, every invariant and the liveness property hold at 3 to 4 servers, 2 changes, terms ≤ 4, each run ≤ 1 h, and on append gives the stuck trace → two independent checkers confirm the rule. Any on-commit counterexample → the healing rules change before DRAFT or MIN can be judged."

- **On append gives the stuck trace: yes.** R2-1 is stuck on append in E-14b's model (135 states) and in the model with no reduction at all (2,905 states, E-14's exact count).
- **On commit, safety: holds.** No real safety property broke in any on-commit run: 10,508,011 distinct states in the eleven complete runs (`four-voters` 5,165,341; `three-1c-rbd` 2,698,102; `r21f-rb` 1,143,532; `two` 558,605; `three-1c1f` 555,676; and six smaller), plus `four-voters-t5` (terms up to 5, complete) and the 2,847,857 states `one` and `three-disk` explored before a shipped invariant stopped them. One of etcd's own invariants, `QuorumLogInv` (as `QuorumLogInvLive`), fires in `one` on a learner two changes behind whose stale configuration is never used; without it, `one-noq` finishes with the other seven invariants holding everywhere, so that is the invariant's strength, not a bug.
- **On commit, liveness: holds from three voters up; fails growing from two to three.** No stuck state with a live majority in `four-voters` (the R2-1 shape from a working leader: 5,165,341 states, complete), `three-1c1f`, `r21`, `r21f`. Stuck states in `two-1c1f` (4) and `two` (6): the two-voter window. This is an on-commit counterexample.
- **Bounds.** 3 to 4 servers, 1 to 2 changes, terms up to 4, one fault. Not finished at these bounds: `three-disk` (2,736,260 states, stopped by the stale-leader invariant above) and `four` (the swap; not run). Each run up to 1 hour: most took minutes; `four-voters` took 92 minutes of wall time on the shared box, in four segments.

So, by the threshold's own rule, the healing rules change, but the change is a rule of operation and a stated limit, not a new mechanism:
1. A group at two voters is not protected against losing its leader until the other voter has applied the promotion. Healing from two voters to three is done when every survivor has applied it, not when it commits. The leader should send its new commit index right after a configuration change commits, so the window is one round trip.
2. If the old leader is lost in that window, the group waits for it; if its disk is lost, the survivors cannot go on by themselves and need an operator step (F-12), or a rule that lets them adopt an appended growth change (on append for growth only: not checked here). DESIGN-V5 §4.2 must say so; F-07 ("comes back once a majority of each group's voters returns, in any order") does not hold in that window.
3. Rules the model shows are needed, to keep in any port of etcd's raft: the campaign guard (E-14), learners vote (new here), a new id for a lost disk (DESIGN-V5 §4.1's incarnation id; new here as a checked rule), and the rules of the caught mutants (step 4).

E-14b is **partial**: the liveness sweep finished for `four-voters`, `two`, `two-1c1f` and the R2-1 and three-voter scenarios, but not for `three-disk` and `four`; the mutants ran exhaustively for 18 of 22, and r19 is inconclusive.

## How to rerun

```sh
./fetch.sh            # CommunityModules 202611060952, tla2tools.jar, etcd's raft at c51f010, into $SP/dl/
./run.sh jar          # step 1 (minutes)
./run.sh calib        # step 2 (about 1 CPU-hour with this box to itself; three-1c-rbd alone is 21 min)
./run.sh sweep        # step 3 (several CPU-hours; long runs are cut into checkpointed segments)
./run.sh mutants      # step 4
python3 tools/table.py   # the tables above, from results/runs.json
python3 tools/mutsum.py  # the mutant table, from results/mutants-exhaustive.json
```

The holds of the heavy lock were scheduled here by a small queue runner outside this folder (orchestration only); `run.sh` runs the same commands, each TLC segment under its own hold.

Q-14: Yes from three voters up, with one stated limit and two more rules: on commit with the campaign guard broke no real safety property in any run and has no stuck state in the finished scenarios that start from three or more voters (four voters demoting one, the R2-1 shape: 5,165,341 states, complete; the lost-disk replacement and the swap did not finish), while on append stays stuck at R2-1; but growing from two voters to three has a one-message window in which losing the leader stalls the group until that leader returns (model-checked; etcd's code does the same; on append does not stall there), learners must vote, and a lost disk must never return under its old id; the real CommunityModules jar changes no E-14 result, and 11 of 22 mutants are caught (85% of those not equivalent). Moves: every row that ports etcd's raft (MIN, MIN-P, MIN-TS, DRAFT, RUST, SRV, LEAN, CELL, LANE, SPLIT, RLOG, EMB-V8, SIDE) up on F-16 and DEV-03, down a little on F-07 (the two-voter window: a stated limit and an operator step if the old leader's disk is lost, no new mechanism), +1 counted rule (learners vote) beside E-14's campaign guard; I `own` down again (etcd's TLA+ spec runs only with CommunityModules' Java FoldBag, and two of its shipped invariants are stronger than Raft needs).
