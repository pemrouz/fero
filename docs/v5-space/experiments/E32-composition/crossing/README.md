# E-32 (b): one model of the riskiest crossing

**Question (Q-32 (b)).** fero v4 broke where its mechanisms met. The v5 study checked each mechanism alone or in pairs. Does the slot move still hold when, in one model and in any order, a leader changes, the source or the target group changes its voters, a group drops its log behind a snapshot, and the move carries the dedup state? Bounds as E-15's (the smallest that hold each thing); properties the union of E-15's and E-14's, plus exactly once at the client (E-20), a reader of the moved slot (E-31) and the mark beside derived outputs (E-30).

**Threshold (QUESTIONS.md, Q-32).** A counterexample that neither single model finds is the strongest evidence against the rows that share the crossing. DEV-03 asks that the model finish within about an hour per bound on this box and catch at least 85% of the one-rule mutants made as DEV-10 (d) says.

**In short.**
@@SHORT@@

## Words used here

- **Slot move**: a slot (a fixed share of a resource's keys) goes from group A (the source) to group B (the target). A writes `exporting`, B writes `importing` and copies the slot's rows, A writes `fenced` (no more writes there) once B reports the copy, A sends the rows written since and `END(N)` with the carried state, and B writes `open`. If B gives the move up (`abort`), A reopens the slot (`unfence`) or cancels it. This is E-17's slot model with one give-up decider (A-17 (4)).
- **Carried set**: what B must hold before it opens: the rows, the slot's last sequence, the dedup outcomes, the session floor, the highest lock token and the `srchi-slot` mark.
- **Leader change, voter change**: each group is a Raft group. When a member fails, the group elects a new leader; the group's own leader then heals it: add a spare as a learner, promote it, remove the gone voter (a swap), and remove a surplus voter if the gone one comes back (E-16's `self`).
- **Log drop**: a group replaces the start of its committed log by one snapshot entry that holds what those entries said (DESIGN-V5 4.1).
- **Session floor** (E-20 `sess`): each copy of a client write carries the client's lowest unacknowledged id. The group forgets dedup outcomes below it, and must not judge a copy below it.
- **Mark** (E-30 `srchi-slot`): for derived outputs, the highest source sequence applied to the slot, written in the output's own entry. An output at or below it is a duplicate.
- **Lock token**: a client write carries a lock token; a write whose token is below the slot's highest is refused as stale (E-17).
- **Calm steps**: commits, deliveries (elections, catch-up, protocol steps, acks) and reads. **AG EF**: from every reachable state a goal can still be reached by calm steps. It is how E-14, E-15, E-16 and E-17 checked liveness.
- **DEV-10**: a **rule** is one guard conjunct or one state update; it counts only if removing it lets the checker find a counterexample (ablation). **Mutants** are made by script: drop each guard, flip each comparison, drop each update, swap each pair of updates in one action.

## What was built, and from which experiments

**The base: E-17's shared harness, not E-15's TLA+.** E-17's Python harness ([../../E17-partitioning/harness/](../../E17-partitioning/harness)) already holds most of the crossing: the slot move with the carried sequence, dedup outcomes and highest lock token; a client whose copies reach any group at any time; a reader with a cursor; a leader deposed with its tail lost. E-16 (healing), E-20 (dedup), E-30 (marks), E-31 (subscribe) and E-33 were built on the same rule language, so their rules port with the same counting, and DEV-10's mutants and ablation are already mechanical there. E-15's TLA+ spec has the move with unclean recovery and `#meta`'s table, but no lock tokens, cursors, members, membership changes or sessions; adding them would be a rewrite, and TLC took 23 minutes on E-15's largest bound for the move alone. So the harness is imported unchanged from E-17's folder, and the composed model is new code beside it:

| File | What it is |
|---|---|
| [model/crossing.py](model/crossing.py) | The rules: E-17's slot model ported line for line, one give-up decider, E-20's session rules, E-30's mark, E-16's five healing actions, and the new log drop (`snap`) |
| [model/cworld.py](model/cworld.py) | E-17's `World`, subclassed: members and replicas (from E-16's world), elections with Raft's log check, membership on commit (E-14), catch-up, member faults (a crash, or a lost disk), the client's acknowledgements (E-20), E-30's pinned `dup` answer, and the added properties |
| [model/cexplore.py](model/cexplore.py) | E-17's breadth-first search with AG EF liveness, asked only where every group has a live majority (E-16's convention) |
| [model/cbounds.py](model/cbounds.py) | The bounds |
| [model/crun.py](model/crun.py), [model/cmut.py](model/cmut.py), [model/cabl.py](model/cabl.py), [model/creport.py](model/creport.py) | Run the bounds; the mutants; the ablation; the tables in [results/](results) |
| [model/repro_base.py](model/repro_base.py) | Step 1: E-17's slot model re-run unchanged |

**Step 1, the base is sound** ([results/base.txt](results/base.txt)). E-17's slot model, re-run unchanged, gives the state count, step count and state digest E-17 stored, on all six of its bounds. The port, with every added part switched off and E-17's two deciders switched on, makes exactly E-17's states and steps on the same six bounds (22,797 to 62,653 states). Model-checked here.

**COMP's picks in the model** (AMENDMENTS section 4).

| Axis or fix | COMP's pick | In this model | Rules from |
|---|---|---|---|
| P `slot`, A-17 | the slot move, one give-up decider, two once guards, the carried set | E-17's slot model; B is the only decider (B aborts; A unfences, or cancels if it had not fenced); `fence.once`, `open.once` (E-17c); carried: rows, sequence, outcomes, floor, highest lock token, mark | E-17, E-17c |
| G `pslot` | a project's groups share its servers | both groups have the same three voters (members 0, 1, 2) and one spare (member 3), so one fault hits A and B at once | E-17b |
| R `raft`, A-01 | Raft, membership on commit | a group is a committed log, the leader's uncommitted tail and the tails lost leaders left; elections with Raft's log check; a config takes effect on commit; a leader its own change removes steps down | E-14, E-14c |
| C `self`, A-19, A-01 (5) | each group's leader heals | E-16's five actions: add a learner, promote (grow first), remove a gone voter, remove a surplus voter once the voters left answer, drop a gone learner | E-16 |
| V `+lrn` | learners | yes | E-14b, E-16 |
| Z `rejoin`, A-28 | a member back without its disk is a new replica | yes: a lost disk gives a new incarnation, never a vote under the old id. COMP marks Z undecided against `par`; this takes `rejoin`, COMP's pick and the one every Raft row holds | E-14b, E-37 |
| D `sess`, A-21 | client sessions | outcomes per slot, the floor per session, carried by the move; a write applies only at or above the floor. `forward.once` is not here (no relay) | E-20 |
| A-05 | `srchi-slot` marks | the mark per slot, written in the output's entry, carried by the move; E-30's `dup` answer (pinned) | E-30 |
| O `slot`, W `any` | per-slot sequences; reads from any replica | positions are (slot, sequence); one reader follows the moved slot through any group's committed log | E-17, E-31 |
| (new) | a log drop behind a snapshot | `snap`: one action, any time, at or below the commit offset; what the snapshot keeps is written one field per update, so the ablation says which fields it needs | DESIGN-V5 4.1; no single experiment modelled it |

**What else from AMENDMENTS section 4's crossings came in.** The list has 28 crossings (K-01 to K-28); one model cannot hold them all. Taken, riskiest first: K-01 (a slot move with a membership change and healing in A or B) and K-02 (the move with what it carries, at once: sequence, outcomes, floors, the highest lock token and marks), and the log drop, which no K line names but which every row has. K-03 is in only as E-17's deposition (a leader lost with its tail) on the bound `all`; K-27 (a give-up when the target is gone for good) only in part (`giveup-dst`: B's leader is gone for good, but B heals). Left out: see Gaps.

## Bounds

E-15's kind: the smallest that hold each of the five things at once, with the place where the fault and the drop strike varied from bound to bound. Every bound has one slot move (p's slot s from A to B; `twice-*` moves it there and back), one member fault (A's leader, B's leader, or the member both groups share; a lost disk is a leader change in one group, a lost voter in both, and a swap of three voter changes), one log drop (A's or B's), and the dedup state the move must carry. Members 0, 1, 2 are both groups' voters; A is led by member 0, B by member 1; member 3 is the spare.

@@BOUNDS@@

**Properties.** Every property is checked in every state (or step) reached; liveness on every bound run in full.

| Id | Property | From |
|---|---|---|
| P1 | no acknowledged write lost or extra: every group that holds the slot open has exactly its history as rows | E-15's 3 and 4; E-17 |
| P2 | a position never changes meaning, and positions rise along the slot's history | E-15's 2 and 6; E-17 |
| P3 | no attempt applied twice; lock tokens never fall; an attempt told "refused" never commits | E-15's 5 and 8; E-17; E-20's ONCE and REFUSED |
| P4 | what the reader took is always a prefix of the history, and only grows: no lost and no repeated record | E-17; E-31's cursor property |
| P6 | at most one group holds the slot open | E-15's 1; E-17 |
| P8 | derived outputs apply once each, in source order | E-30's ONCE |
| DP | an output answered "already applied" has its source record's output applied (bounds `remit-*`) | E-30's DONE |
| QL | every majority of a group's committed voters holds a replica with every committed entry (live disks) | E-14's QuorumLogInv, as E-14 ran it (QuorumLogInvLive) |
| LC | a leader holds every committed entry | E-14's LeaderCompletenessInv |
| CF | a group's config is the last config change it committed | E-14's CommittedIsDurableInv, for config entries (P1 covers data) |
| LV | a leader is a voter of its group's committed config | E-14c's r19 |
| HV | a healing group keeps three voters, or four inside a swap | E-16's P3 |
| HR | a removal never lowers the answering voters that hold the commit offset below three | E-16's P2 |
| L4, L5, L5b, L5g, L7 | the reader can catch up; the move can end; the planned move can finish (from every state reached with no give-up); a give-up gives the slot back to A alone; every write gets an answer | E-17; E-15's 7 |
| LH | healing finishes | E-16's P8 |

Not checked here: E-15's 9 (`#meta`'s table names the holder): this model has no slot table, and the move is a fixed plan. E-14's ElectionSafety, MoreThanOneLeader, LogMatching, LogInv and MoreUpToDateCorrect hold by construction: a group here has one leader field and one log (reasoned; E-14 checked them on etcd's spec).

## Results

Every bound holds every property ([results/design.md](results/design.md), raw lines in [results/design.txt](results/design.txt)). 26 of the 28 bounds were explored in full, with liveness (AG EF) from every judged state: the move can always finish, healing can always finish, every write can get its answer, the reader can always catch up, and a give-up always gives the slot back to A. The smallest bound, `src`, has 26,724 states; the largest in full, `heal2-dst`, 2,612,006 states in 14 minutes. Each run in full fits DEV-03's hour. The two widest bounds, `any` and `all`, stop at 2.5 million states each with no counterexample (partial: safety only). Model-checked here, with the fix below in place.

| Bound | What it holds | States | Steps | Judged for liveness | Seconds | Explored | Result |
|---|---|---|---|---|---|---|---|
| `src` | w1; member 0 loses its disk (never back); heals: A; 1 drop at A | 26,724 | 53,747 | 26,724 | 6 | in full | every property holds |
| `dst` | w1; member 1 loses its disk (never back); heals: B; 1 drop at B | 36,716 | 67,875 | 36,716 | 7 | in full | every property holds |
| `src-dst` | w1; member 0 loses its disk (never back); heals: B; 1 drop at B | 47,204 | 104,335 | 47,204 | 10 | in full | every property holds |
| `dst-src` | w1; member 1 loses its disk (never back); heals: A; 1 drop at A | 30,882 | 67,151 | 30,882 | 6 | in full | every property holds |
| `mark-src` | o1, o2; member 0 loses its disk (never back); heals: A; 1 drop at A; derived outputs | 56,196 | 93,333 | 56,196 | 11 | in full | every property holds |
| `mark-dst` | o1, o2; member 1 loses its disk (never back); heals: B; 1 drop at B; derived outputs | 63,438 | 97,675 | 63,438 | 13 | in full | every property holds |
| `read-src` | w1; member 0 loses its disk (never back); heals: A; 1 drop at A; a reader | 49,360 | 146,219 | 49,360 | 10 | in full | every property holds |
| `read-dst` | w1; member 1 loses its disk (never back); heals: B; 1 drop at B; a reader | 66,036 | 179,059 | 66,036 | 14 | in full | every property holds |
| `giveup-src` | w1; member 0 loses its disk (never back); heals: A; 1 drop at A; B may give up | 110,026 | 223,547 | 110,026 | 23 | in full | every property holds |
| `giveup-dst` | w1; member 1 loses its disk (never back); heals: B; 1 drop at B; B may give up | 139,182 | 301,447 | 139,182 | 30 | in full | every property holds |
| `crash-src` | w1; member 0 crashes (may come back); heals: A; 1 drop at A | 162,142 | 422,400 | 162,142 | 35 | in full | every property holds |
| `crash-dst` | w1; member 1 crashes (may come back); heals: B; 1 drop at B | 239,782 | 594,267 | 239,782 | 53 | in full | every property holds |
| `floor-src` | w1, w2; member 0 loses its disk (never back); heals: A; 1 drop at A; rising lock tokens | 323,504 | 766,693 | 323,504 | 72 | in full | every property holds |
| `floor-dst` | w1, w2; member 1 loses its disk (never back); heals: B; 1 drop at B; rising lock tokens | 350,768 | 773,793 | 350,768 | 77 | in full | every property holds |
| `floors-src` | w1, w2; member 0 loses its disk (never back); heals: A; 1 drop at A; one write at a time, rising lock tokens | 176,560 | 358,609 | 176,560 | 41 | in full | every property holds |
| `floors-dst` | w1, w2; member 1 loses its disk (never back); heals: B; 1 drop at B; one write at a time, rising lock tokens | 183,536 | 341,089 | 183,536 | 43 | in full | every property holds |
| `twice-src` | w1; member 0 loses its disk (never back); heals: A; 1 drop at A; moves to B and back | 336,916 | 628,516 | 336,916 | 75 | in full | every property holds |
| `twice-dst` | w1; member 1 loses its disk (never back); heals: B; 1 drop at B; moves to B and back | 511,554 | 931,076 | 511,554 | 114 | in full | every property holds |
| `slots-src` | w1, w3; member 0 loses its disk (never back); heals: A; 1 drop at A; one write at a time, one write on the moving slot, one on the slot that stays | 264,308 | 558,593 | 264,308 | 60 | in full | every property holds |
| `slots-dst` | w1, w3; member 1 loses its disk (never back); heals: B; 1 drop at B; one write at a time, one write on the moving slot, one on the slot that stays | 234,540 | 478,917 | 234,540 | 53 | in full | every property holds |
| `floore-src` | w1, w2; member 0 loses its disk (never back); heals: A; 1 drop at A; one write at a time, equal lock tokens | 176,560 | 358,609 | 176,560 | 39 | in full | every property holds |
| `floore-dst` | w1, w2; member 1 loses its disk (never back); heals: B; 1 drop at B; one write at a time, equal lock tokens | 183,536 | 341,089 | 183,536 | 40 | in full | every property holds |
| `remit-src` | o1, o1r; member 0 loses its disk (never back); heals: A; 1 drop at A; derived outputs, one re-emitted under a new id | 51,180 | 92,391 | 51,180 | 11 | in full | every property holds |
| `remit-dst` | o1, o1r; member 1 loses its disk (never back); heals: B; 1 drop at B; derived outputs, one re-emitted under a new id | 68,820 | 116,032 | 68,820 | 15 | in full | every property holds |
| `heal2-src` | w1; member 0 loses its disk (never back); heals: A, B; 1 drop at A | 1,373,695 | 3,327,956 | 1,373,695 | 407 | in full | every property holds |
| `heal2-dst` | w1; member 1 loses its disk (never back); heals: A, B; 1 drop at B | 2,612,006 | 6,244,395 | 2,612,006 | 856 | in full | every property holds |
| `any` | w1; member 0 or 1 or 2 loses its disk (never back); heals: A, B; 1 drop at A or B | 2,500,001 | 6,003,555 | 0 | 553 | PARTIAL: stopped at the state limit | no counterexample (safety only; liveness not judged) |
| `all` | w1; member 0 or 1 or 2 crashes or loses its disk (may come back); heals: A, B; 2 drop at A or B; a reader, B may give up | 2,500,002 | 7,151,236 | 0 | 381 | PARTIAL: stopped at the state limit | no counterexample (safety only; liveness not judged) |

"Judged for liveness" counts the states where every group has a live majority of its committed voters; with one member fault among three voters that is every state. No run hit the log's length cap (12 entries a group).

## The counterexample found while composing, and its fix

**What broke** ([results/found-refuse-above.txt](results/found-refuse-above.txt)). With E-20's floor on E-17's write path but not on E-17's refusal path, P3 breaks in 6 steps (shortest, breadth first), on `floors-src`:

```
1. write ('w1', 'G0', 'floor=1')          w1 (lock token 1) applies at A
2. commit G0 w1
3. ack w1                                   the client has its answer; its floor is now 2
4. write ('w2', 'G0', 'floor=2')          w2 (token 2) carries floor 2; A forgets w1's outcome
5. commit G0 w2
6. refuse ('w1', 'G0')                     a late copy of w1: not among the outcomes any more, token 1 < 2: "refused"
```

w1 is both applied and told "refused". Only the client saw step 3, so the late answer goes to a client that no longer waits; it is harmful wherever anything acts on a late answer (a relay's reply cache under Y `fwd`, or a client that logs answers). Reasoned.

**What it crosses.** E-20's session floor (forget outcomes below the client's lowest unacknowledged id) and E-17's lock-token refusal (refuse a write whose token is below the slot's highest). It needs no move, no leader change and no snapshot.

**Why the single models missed it.** E-17 keeps every outcome for ever, so its refusal always sees a write that already applied. E-20 has the floor on every path that judges a copy (its `judge()` puts `floor` on `apply`, `refuse_r` and `refuse_f`), but its refusals are a free condition, not a lock token. So neither design is wrong. The slip is the kind composing invites: a rule each experiment wrote for "the paths that judge a copy" must cover every such path the other experiment adds.

**The fix, and its precedent.** `refuse.above`: a copy below the session's floor is never judged; it is answered `stale` (E-20's own rule, on one more path). Precedent: the Raft thesis, section 6.3 (Ongaro, 2014): a session's request below the lowest unacknowledged id is not executed again, and its old reply may have been discarded. Every bound in the results table runs with the fix. Dropping it again breaks P3 on `floors-src` and `floors-dst` and nowhere else (mutant `G refuse.above`).

**No counterexample needed the five things together.** With the fix, every bound holds: no broken safety property, and no stuck state from which a live majority cannot finish the move, heal, answer every write and let the reader catch up. Model-checked here, at these bounds.

## Three carried pieces the first bounds never tested

The differential pass of the mutant run (below) showed that three of the carried pieces were never the only thing between a duplicate and the slot, so their rules were spare on every one of the first 12 bounds:
- **The floor.** Each later write had a higher lock token, so the token fence stopped every late copy before the floor had to (`G write.above`: the model's own steps in every reachable state).
- **The mark.** Derived outputs kept their outcomes for ever, so the outcomes caught every duplicate output (`G write.mark`: the same). E-30's case is a consumer that restarts past the dedup horizon and emits the output of the same source record under a new id.
- **The lock token.** Every write was in one client session, so the outcomes or the floor stopped every stale copy before the token had to (`G write.fence`: the same; `U snap.tok` survived). E-17 tested the token with two lock holders and no session.

Six bounds were added on resuming, so that each piece is the only guard somewhere: `floore-src` and `floore-dst` (two session writes with equal lock tokens), `remit-src` and `remit-dst` (one source record emitted twice, under two ids; E-30's pinned `dup` answer is on there), and `lock-src` and `lock-dst` (two lock holders, tokens 1 and 2, no session). Every property holds on all six as designed. Dropped one at a time ([results/carry-checks.txt](results/carry-checks.txt)):

| Rule dropped | What it says | `floore-src` | `floore-dst` | `remit-src` | `remit-dst` | `lock-src` | `lock-dst` |
|---|---|---|---|---|---|---|---|
| `write.above` | E-20: apply only at or above the session's floor | P3, 7 steps | P3, 7 | | | | |
| `final.floor` | the move carries the session's floor | P3, 19 | P3, 19 | | | | |
| `final.outs` | the move carries the dedup outcomes | P3, 16 | P3, 16 | | | | |
| `snap.floor` | a snapshot keeps the floor | P3, 8 | P3, 20 | | | | |
| `snap.outs` | a snapshot keeps the outcomes | P3, 5 | P3, 17 | | | | |
| `write.mark` | E-30: apply an output only above the slot's mark | | | P8, 4 | P8, 4 | | |
| `write.src` | E-30: the source sequence is written in the output's own entry | | | P8, 4 | P8, 4 | | |
| `final.mark` | the move carries the mark | | | P8, 16 | P8, 16 | | |
| `snap.mark` | a snapshot keeps the mark | | | P8, 5 | P8, 17 | | |
| `write.floor` | a write's entry records the floor its copy carried | holds | holds | | | | |
| `write.fence` | E-17: apply only at or above the slot's highest lock token | | | | | P3, 4 | P3, 4 |
| `final.tok` | the move carries the highest lock token | | | | | P3, 16 | P3, 16 |
| `snap.tok` | a snapshot keeps the highest lock token | | | | | P3, 5 | P3, 17 |
| `refuse.stale` | E-17: refuse only a token below the slot's highest | | | | | P3, 3 | P3, 3 |

The snapshot rows are crossings no single experiment could see: E-20 and E-30 had no log drop, E-17 had none either, and E-31's snapshots carried rows and no dedup state. A snapshot that leaves out the floor lets a late copy apply twice (8 steps: w1 applies, the client takes its answer, w2 carries floor 2 and A forgets w1's outcome, A drops its log behind a snapshot without the floor, the late copy of w1 applies again). A snapshot that leaves out the mark does the same for a re-emitted output (5 steps), and one that leaves out the highest lock token lets the older lock holder's write apply after the newer one's (5 steps). The move that leaves out the mark, 16 steps: o1 applies at A, the move runs to `open` with the outcomes but no mark, and the re-emitted o1r applies at B. Full traces in [results/carry-checks.txt](results/carry-checks.txt).

These six joined the mutant and ablation sweep (18 bounds). Two rules stay spare even here, and the ablation pins them (written, never dropped, not counted), as E-20 pins its memory bound and the append of the write itself. `write.floor` (a write's entry records the floor its copy carried): without it the floor never rises and outcomes are kept for ever, which is safe but unbounded. `snap.cut` (the log below the offset is dropped): without it no log is ever dropped, which is safe and leaves no log drop to check.

## Mutants (DEV-10 (d))

@@MUTANTS@@

## Ablation of the rules added at the crossing (DEV-10 (c))

@@ABLATION@@

## Gaps

**Crossings from AMENDMENTS section 4 left out**, and why (one model at these bounds cannot hold more; the riskiest shared ones came first):
- **K-07** (`#meta`'s move loop, with `#meta` down or changing leader): moves here are a fixed plan, as in E-17; `#meta` and its slot table are not modelled, so E-15's property 9 is not checked either. This is the next crossing to compose, because COMP's C `self` rests on E-16's reasoning that the loop can sit off the healing path.
- **K-03** (a move cut to one or two commits, A-17 (3), with unclean recovery): the move here is E-17's six steps. Unclean recovery is in only as E-17's deposition (a leader lost with its uncommitted tail), on the partial bound `all`.
- **K-27** (a give-up when the target is gone for good): in part. On `giveup-dst` B's leader is gone for good but B heals; liveness is asked only where every group has a live majority, so a target that never has one again is not judged.
- **K-09** (the `memory` rung with `rejoin`): every entry here is durable once committed; the unsynced tail a `memory` rung can lose is not modelled. **K-13, K-14, K-23** (a restore): not modelled. **K-11, K-12** (writer time, TTLs, leases): no clocks.
- **K-16, K-02's lock fence table**: the move carries only the slot's highest lock token (E-17), not a table per lock (E-24).
- **K-21, K-02's segment names**: no object-store tier. A snapshot here keeps every record of the slot with its position, so a reader below a log drop always reads from the snapshot. A real snapshot keeps state, and a log reader below it needs the tier's segments and E-31's `END` answer, which E-31 checked alone.
- **K-04, K-05, K-06, K-15, K-25** (many resources, `pslot` with Q `mix`, big records, 4,096 slots, the carried set's size): two slots, one resource, one class of group.
- **K-08, K-10, K-17 to K-20, K-22, K-26, K-28**: outside this crossing (leaves and hints, the `none` rung, the slow-leader rule, credits, merged views, the worker seam, quiet groups, groups below three voters, CheckQuorum).
- **K-24** is in, in part: a lost disk wipes the member's replica in every group at once (one journal per process), and on `heal2-*`, `any` and `all` both groups heal. E-37's single bad entry is not modelled.

**Other gaps.**
- **Y `fwd`**: copies go straight to the groups (E-17's world). A-21's `forward.once` is not here.
- **One session, one consumer.** E-20's session registry, expiry by `#s` and a client restart are not here; nor is E-30's consumer cursor in `#groups`.
- **The smallest composed model** (start from the smallest rule sets each single experiment ended on, put back what the crossing needs, then mutate that model) was not run, for the CPU budget. `./run.sh union` does it. So the rule count here is the crossing's added rules, not a count of the whole composed model.
- **Two bounds are partial**: `any` and `all` stop at 2.5 million states, safety only, no counterexample.
- **The design runs of the first 12 small bounds were redone** on resuming: the copies made before the last edits to the model (the CF ghost) had other state digests, though the same counts. The later runs (`floor-*`, `twice-*`, `slots-*`, `heal2-src`) gave the same digests when two of them were re-run, so they were kept.

## What this box cannot show

- **Only small bounds.** Two groups, four members, one move (two in `twice-*`), one member fault, one or two log drops, one or two writes. Python explores about 4,000 states a second here; the two largest bounds (`any`, `all`) stop at 2.5 million states and give safety only.
- **No time.** The model is about order, not speed: it says nothing about how long a move, a swap or a snapshot takes, or how big the carried set is (K-25).
- **Raft is abstract.** A group is one log with a committed prefix, one leader's tail and the tails lost leaders left. Terms, vote messages and the details of etcd's raft are E-14's, not checked again here.
- **Not a second checker.** E-15 compared two checkers on the slot move; this model has one. The port was checked against E-17's model state for state, which is the same harness.

## Reproduce

`./run.sh` re-runs every step (Python 3.13, standard library only; E-17's harness and E-16's and E-17's result files beside this folder). Each check runs under the study's heavy lock in pieces of at most about 25 minutes; big checkpoints stay in `$SP/e32b`. Machine and versions: [results/machine.txt](results/machine.txt). CPU used: @@CPU@@.

@@VERDICT@@
