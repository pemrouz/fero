# E-32 (b): one model of the riskiest crossing

**Question (Q-32 (b)).** fero v4 broke where its mechanisms met. The v5 study checked each mechanism alone or in pairs. Does the slot move still hold when, in one model and in any order, a leader changes, the source or the target group changes its voters, a group drops its log behind a snapshot, and the move carries the dedup state? Bounds as E-15's (the smallest that hold each thing); properties the union of E-15's and E-14's, plus exactly once at the client (E-20), a reader of the moved slot (E-31) and the mark beside derived outputs (E-30).

**Threshold (QUESTIONS.md, Q-32).** A counterexample that neither single model finds is the strongest evidence against the rows that share the crossing. DEV-03 asks that the model finish within about an hour per bound on this box and catch at least 85% of the one-rule mutants made as DEV-10 (d) says.

**In short.**
- **One model now holds the crossing**: one slot move from group A to group B, a leader change, a voter swap in A or B (add a learner, promote it, remove the lost voter), a log drop behind a snapshot, and the dedup state the move carries (session outcomes and floor, the highest lock token, the `srchi-slot` mark), all in any order but one: in the design runs the source group never drops its log between its `exporting` and B's committed final copy, because DESIGN-V5 4.1's guard ("no slot move is still copying from it") is kept, and that removes 20% to 54% of the reachable states on the bounds where it applies (`src`: 26,724 of 56,060 are left). Runs without the guard hold too, on all 15 full bounds where it changes anything (review). It is built on E-17's shared harness, reused unchanged, with E-16's healing, E-20's sessions and E-30's marks ported onto it, and a log drop no single experiment had. Step 1 reproduced E-17's slot model exactly, and the port with the new parts switched off makes E-17's states and steps exactly.
- **Every bound explored in full holds every property it checks** (model-checked here): E-15's 1 to 8 (not 9: no slot table), E-14's, E-16's, exactly once at the client (E-20), E-17's reader cursor (the property E-31 also checks; E-31's protocol is not here) and once-only derived outputs (E-30), with liveness (AG EF: the move, healing, every answer and the reader can always finish). 28 bounds in full, from 26,724 to 2,612,006 states, each within DEV-03's hour; the two widest stop at 2.5 million states with no counterexample (partial: safety only, not a pass). **Review:** two of these properties could not fail on these bounds: the reader's "no gap" (every reader bound has one write) and E-14's leader completeness (one member fault, so no election ever meets a voter behind the log). The review added bounds where each can fail: two writes with a reader (`read2-src`, `read2-dst`: hold, in full) and two crashes (`crash2-src`: no counterexample in 3 million states, partial).
- **One counterexample, found while composing** (6 steps): a write both applied and told "refused". E-17's lock-token refusal judged a late copy whose outcome E-20's session floor had already forgotten. It needs no move. Neither single model could find it (E-17 never forgets outcomes; E-20 has no lock token). The fix is E-20's own rule on one more path: never judge a copy below the session's floor (`refuse.above`; precedent: the Raft thesis, section 6.3). Every bound runs with it.
- **The crossing makes the snapshot's contents rules.** A snapshot must keep the floor, the outcomes, the mark and the highest lock token beside the rows, or a duplicate applies after a log drop (5 to 20 steps without each). The move must carry the floor, the mark and the token (16 to 19 steps). E-20, E-30 and E-17 had no log drop, and E-31's snapshots held rows only, so no single experiment could see these. They became visible only after six bounds were added on resuming: in the first 12 bounds the floor, the mark and the token were never the only guard (the differential pass showed it).
- **Rules (DEV-10 (c))**: of the 24 rules the crossing added (two more pinned), 20 are needed, each with a counterexample: 13 fields a snapshot keeps and its commit-offset guard, and 6 floor and mark rules on E-17's write, refusal and carry paths. DESIGN-V5 4.1's "no slot move is still copying from it" is spare here: the copy reads the slot's state, which the snapshot keeps whole (it is still kept in every design run).
- **Mutants (DEV-10 (d))**: 95 of the 136 that change a step are caught, **70%, below DEV-03's 85%**. Where dedup meets the move and the log drop (`write`, `refuse`, the carry, the log drop) it is 85% (64 of 75); the misses sit in E-17's move steps and E-16's healing guards, which those experiments' own ablations also found spare at small bounds, and in once guards this world cannot test (E-15 found the same for the move alone: 39%).
- **Left out** (CPU budget: about 10 CPU-hours used against the 8 aimed for): `#meta`'s move loop (K-07), a restore, the `memory` rung, writer time, relays, the object-store tier and segment names, and the smallest composed model (`./run.sh union`). Also left out (review): E-31's subscribe protocol (its `END` answer included), E-16's link faults, E-37's checksum, and any second member fault on the bounds run in full.
- **Reviewed** (section "Review"): the model is composed (the five share each group's one log, leader and members), the counts reproduce exactly (`src`, `slots-dst`, `heal2-src`: same states, steps and state digests), and the README's claims now say what the runs show. Of four bugs the review planted at the crossing, all four are caught, but two only on bounds the review added.

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
| R `raft`, A-01 | Raft, membership on commit | a group is a committed log, the leader's uncommitted tail and the tails lost leaders left; elections with Raft's log check; a config takes effect on commit; a leader its own change removes steps down. **Review:** a config takes effect at every member at the same moment, so A-01's rules (1) (no campaign while a committed change is unapplied) and (2) (learners grant votes) have nothing to act on and are not modelled; and at one member fault Raft's log check never decides an election (see LC) | E-14, E-14c |
| C `self`, A-19, A-01 (5) | each group's leader heals | E-16's five actions: add a learner, promote (grow first), remove a gone voter, remove a surplus voter once the voters left answer, drop a gone learner. **Weakened (review):** "gone to the leader" is read as "down"; E-16's links, partitions and eviction marks are not here, so `add.cand` lost its "not marked gone" part, and there is one member fault, not E-16's two | E-16 |
| V `+lrn` | learners | yes | E-14b, E-16 |
| Z `rejoin`, A-28 | a member back without its disk is a new replica | yes: a lost disk gives a new incarnation, never a vote under the old id. COMP marks Z undecided against `par`; this takes `rejoin`, COMP's pick and the one every Raft row holds. **Review:** E-37's checksum rule (damage becomes a wipe) is not here, and a member that comes back with a new disk appears only on the partial bound `all`: on every bound run in full a lost disk never returns | E-14b, E-37 |
| D `sess`, A-21 | client sessions | outcomes per slot, the floor per session, carried by the move; a write applies only at or above the floor. `forward.once` is not here (no relay) | E-20 |
| A-05 | `srchi-slot` marks | the mark per slot, written in the output's entry, carried by the move; E-30's `dup` answer (pinned). **Review:** E-30's `fence.carry` and `open.carry` are one rule here (`final.mark`: `open` reads the mark from the copy entry), and E-30's cursor rule `commit.acked` is replaced by a world rule in `write`'s parameters (the output of source record k is sent only once k−1's output is applied); E-30's LOST property is not checked (no consumer cursor) | E-30 |
| O `slot`, W `any` | per-slot sequences; reads from any replica | positions are (slot, sequence); one reader follows the moved slot through any group's committed log. **Review:** this is E-17's reader, not E-31's protocol: no replica lags, so E-31's `END` answer (and `moved`, `retry`, `expired`, modes, relays) is not modelled | E-17 (E-31's property only) |
| (new) | a log drop behind a snapshot | `snap`: one action, at the commit offset (the whole committed prefix; never part of it), whenever the group has a leader, but never at a source while a move is copying from it (DESIGN-V5 4.1's guard, kept in every design run); one snapshot for the whole group, so no follower ever lags behind it; what the snapshot keeps is written one field per update, so the ablation says which fields it needs | DESIGN-V5 4.1; no single experiment modelled it |

**What else from AMENDMENTS section 4's crossings came in.** The list has 28 crossings (K-01 to K-28); one model cannot hold them all. Taken, riskiest first: K-01 (a slot move with a membership change and healing in A or B) and K-02 (the move with what it carries, at once: sequence, outcomes, floors, the highest lock token and marks), and the log drop, which no K line names but which every row has. K-03 is in only as E-17's deposition (a leader lost with its tail) on the bound `all`; K-27 (a give-up when the target is gone for good) only in part (`giveup-dst`: B's leader is gone for good, but B heals). Left out: see Gaps.

## Bounds

E-15's kind: the smallest that hold each of the five things at once, with the place where the fault and the drop strike varied from bound to bound. Every bound has one slot move (p's slot s from A to B; `twice-*` moves it there and back), one member fault (A's leader, B's leader, or the member both groups share; a lost disk is a leader change in one group, a lost voter in both, and a swap of three voter changes), one log drop (A's or B's), and the dedup state the move must carry. Members 0, 1, 2 are both groups' voters; A is led by member 0, B by member 1; member 3 is the spare.

| Bounds | What they add to the core | Why |
|---|---|---|
| `src`, `dst`, `src-dst`, `dst-src` | the core: one session write; the member that leads A (`src`) or B (`dst`) loses its disk for good; the group named second heals and may drop its log | a leader change in one group is a lost voter in the other (`pslot`), so the four cover "who loses its leader" against "who heals and drops" |
| `mark-*`, `remit-*` | derived outputs (E-30); `remit-*` emits one source record twice under two ids | the mark beside outputs, carried by the move and kept by a snapshot |
| `lock-*` | two lock holders with no session (tokens 1 and 2) | the highest lock token, carried and kept |
| `read-*` | a reader of the moved slot | E-31's cursor property, across the move, the leader change and the log drop. With one write the reader cannot skip a record; the review's `read2-*` (two writes) can |
| `giveup-*` | B may give the move up (one decider: B aborts, A reopens or cancels) | A-17 (4) with a leader change and a log drop |
| `crash-*` | the member only crashes and may come back at any time | catch-up, a surplus voter removed after the swap, a rejoining leader |
| `floor-*`, `floors-*`, `floore-*` | two session writes, so an outcome is forgotten below the floor before the move carries it; `floors-*` sends one write at a time; `floore-*` gives both writes the same lock token | the session floor |
| `slots-*` | one write on the moving slot, one on the slot that stays | the floor is per session, the outcomes per slot |
| `twice-*` | the slot moves to B and back | stale move names, a second move after a log drop (E-17's `twice`) |
| `heal2-*` | both groups heal at once (one member was a voter of both) | two leaders healing around one move |
| `any` | any of the three voters loses its disk; both groups heal; either may drop | partial: everything placed anywhere |
| `all` | as `any`, but the member may come back empty (Z `rejoin`) or just crash, two log drops, the give-up path, the reader, and one leader deposed with its tail lost (E-17's crash) | partial: everything at once |

Like E-15's smaller bounds (`move`, `write0`: two shards, one move), these have two groups and one move (two in `twice-*`). E-15's largest bound (three shards, two moves, one unclean recovery) is out of reach here, because each added mechanism (members, healing, sessions, snapshots) multiplies the states. Every bound but `any` and `all` fits in one lock hold.

**Properties.** Every property is checked in every state (or step) reached; liveness on every bound run in full.

| Id | Property | From |
|---|---|---|
| P1 | no acknowledged write lost or extra: every group that holds the slot open has exactly its history as rows | E-15's 3 and 4; E-17 |
| P2 | a position never changes meaning, and positions rise along the slot's history | E-15's 2 and 6; E-17 |
| P3 | no attempt applied twice; lock tokens never fall; an attempt told "refused" never commits | E-15's 5 and 8; E-17; E-20's ONCE and REFUSED |
| P4 | what the reader took is always a prefix of the history, and only grows: no lost and no repeated record | E-17; E-31's cursor property. **Review:** every `read-*` bound has one write, so no record can be skipped there (mutant G `read.next` is equivalent on all 18 sweep bounds); the review's `read2-*` bounds have two |
| P6 | at most one group holds the slot open | E-15's 1; E-17 |
| P8 | derived outputs apply once each, in source order | E-30's ONCE |
| DP | an output answered "already applied" has its source record's output applied (bounds `remit-*`) | E-30's DONE |
| QL | every majority of a group's committed voters holds a replica with every committed entry (live disks) | E-14's QuorumLogInv, as E-14 ran it (QuorumLogInvLive) |
| LC | a leader holds every committed entry | E-14's LeaderCompletenessInv. **Review:** with one member fault no election ever meets a live voter behind the log, so LC (and QL through an election) cannot fail on the README's bounds even with Raft's log check removed; the review's `crash2-src` (two crashes) is where it can |
| CF | a group's config is the last config change it committed | E-14's CommittedIsDurableInv, for config entries (P1 covers data) |
| LV | a leader is a voter of its group's committed config | E-14c's r19 |
| HV | a healing group keeps three voters, or four inside a swap | E-16's P3 |
| HR | a removal never lowers the answering voters that hold the commit offset below three | E-16's P2 |
| L4, L5, L5b, L5g, L7 | the reader can catch up; the move can end; the planned move can finish (from every state reached with no give-up); a give-up gives the slot back to A alone; every write gets an answer | E-17; E-15's 7 |
| LH | healing finishes | E-16's P8 |

Not checked here: E-15's 9 (`#meta`'s table names the holder): this model has no slot table, and the move is a fixed plan. E-14's ElectionSafety, MoreThanOneLeader, LogMatching, LogInv and MoreUpToDateCorrect hold by construction: a group here has one leader field and one log (reasoned; E-14 checked them on etcd's spec). Also not checked (review): E-30's LOST (no consumer cursor here), and E-31's own properties (no false `expired`, `END` and `moved` answers): only E-17's reader property P4 is here.

## Results

Every bound explored in full holds every property it checks ([results/design.md](results/design.md), raw lines in [results/design.txt](results/design.txt)). Every run in this table keeps DESIGN-V5 4.1's guard `snap.nomove`, so on the bounds where A drops its log, A never drops it between its `exporting` and B's committed final copy; the runs without the guard are in the Review. 28 of the 30 bounds were explored in full, with liveness (AG EF) from every judged state: the move can always finish, healing can always finish, every write can get its answer, the reader can always catch up, and a give-up always gives the slot back to A. The smallest bound, `src`, has 26,724 states; the largest in full, `heal2-dst`, 2,612,006 states in 14 minutes. Each run in full fits DEV-03's hour. The two widest bounds, `any` and `all`, stop at 2.5 million states each with no counterexample (partial: safety only). Model-checked here, with the fix below in place.

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
| `lock-src` | w1, w2; member 0 loses its disk (never back); heals: A; 1 drop at A; two lock holders, no session | 83,272 | 144,241 | 83,272 | 17 | in full | every property holds |
| `lock-dst` | w1, w2; member 1 loses its disk (never back); heals: B; 1 drop at B; two lock holders, no session | 98,734 | 160,663 | 98,734 | 20 | in full | every property holds |
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

**The fix, and its precedent.** `refuse.above`: a copy below the session's floor is never judged (E-20's own rule, on one more path). E-20 answers such a copy `stale`; this model sends it no answer at all, since the client already took one (review: the model has no `stale` step). Precedent: the Raft thesis, section 6.3 (Ongaro, 2014): a session's request below the lowest unacknowledged id is not executed again, and its old reply may have been discarded. Every bound in the results table runs with the fix. Dropping it again breaks P3 on `floors-src` and `floors-dst` and on no other of the 18 sweep bounds (mutant `G refuse.above`; `floor-*` were not in the sweep).

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

Made by script from the model text ([model/cmut.py](model/cmut.py)), never picked by hand: drop each guard conjunct (74), flip each comparison (10), drop each state update (49), swap each pair of updates inside one action (175): 308 mutants over all 18 actions, so every action where two of the five things meet has its mutants. A **differential pass** first explores the unmutated model once per bound and, in every reachable state, evaluates each mutant's version of each action beside the model's own; a mutant that never takes a different step reaches exactly the model's states, so it is **equivalent** on that bound. Each mutant that differs is then run alone on the bounds where it differs, cheapest first, stopping at the first broken property. A mutant whose search passes 10 times the model's own states on a bound with nothing broken is stopped there (E-15's `unbounded` class), and after two such bounds it is not run further (CPU budget). Sweep: the 18 bounds `src` to `floore-dst` (the `lock-*`, `remit-*` and `floore-*` pairs joined on resuming; every mutant not yet caught was run on them too). Full table: [results/mutants.md](results/mutants.md).

| Kind | Made | Caught | Unbounded | Survived | Equivalent |
|---|---|---|---|---|---|
| drop a guard conjunct | 74 | 27 | 5 | 19 | 23 |
| flip a comparison | 10 | 6 | 0 | 1 | 3 |
| drop a state update | 49 | 36 | 1 | 11 | 1 |
| swap two updates | 175 | 26 | 0 | 4 | 145 |
| **all** | **308** | **95** | **6** | **35** | **172** |

**95 of the 136 that change a step are caught: 70%, below DEV-03's 85%.** None is ill-formed. (Review: "equivalent" here means equivalent on the 18 sweep bounds. Two of the 172 are caught on bounds outside the sweep: G `read.next` on `read2-src`, P4 in 6 steps, and C `refuse.above` on `floor-src`, L7 in 1 step. The sweep was not re-run, so the counts stay as they are.) Not counting the two pinned rules' mutants (below), 95 of 134 (71%); not counting the unbounded ones either, 95 of 128 (74%).

**Where they are caught.** In the actions where the dedup state meets the move or the log drop, the rate meets the bar: `write` 14 of 15, `refuse` 5 of 6, `final` (the carry) 16 of 18, `snap` (the log drop) 29 of 36: **64 of 75, 85%**. The rate falls in E-17's move steps (`import`, `copy`, `fence`, `open`, `abort`, `unfence`, `cancel_on_abort`: 14 of 35) and in E-16's healing actions (`add`, `promote`, `remove`, `surplus`, `dropl`: 11 of 20).

**The 41 not caught, by kind** (reasoned from each mutant's rule; the run says only that nothing broke):

| Kind | Mutants | Why nothing breaks |
|---|---|---|
| a once guard | G `open.once`, `abort.once`, `unfence.once`, `cancel_on_abort.once`, `import.new` | E-17's world never appends an entry that is already in the log, so an exact repeat cannot happen with or without the guard. E-17c found two of these (`fence.once`, `open.once`) needed in a real log, which can hold a repeat; this world cannot show it |
| the bulk copy | G `copy.impcom`, `copy.noabort`, `fence.ready`; U `copy.recs`; S `copy:recs<->append` | the bulk copy is a performance step: the copy after the fence carries the rows again, so a wrong or missing bulk copy is overwritten before B opens. E-17 marks these rules `perf`, and its own smallest model has no bulk copy at all |
| a second carrier of one number | U `fence.N`, `final.seq`, `open.N`, `unfence.N`; S `fence:N<->append`, `open:N<->append`, `unfence:N<->append` | the slot's last sequence is read as the highest one any entry names, and `END(N)` names it again, so losing one stamp loses nothing |
| a second check | G `refuse.open`, `fence.nocancel`, `final.noabort`, `open.cpcom`, `cancel_on_abort.nofen`; `abort.imp` (unbounded) | another guard on the path, or the log's order, already ensures it (for example, `open` follows the final copy in B's log, so it can only commit after it). E-15 found the same kind (its class 4) |
| healing, at one member fault | G `add.need`, `promote.caught`, `promote.need`, `surplus.idle`, `surplus.last`; `add.cand`, `add.new`, `promote.learner`, `dropl.learner` (unbounded) | E-16's own ablation dropped `add.need`, `promote.caught`, `surplus.idle`, `add.cand` and `dropl.learner` too. The other four E-16 needed with up to two faults; here there is one, and four of the nine let the leader propose config entries without end (the log cap and the state limit end the search, with nothing broken) |
| safe to leave out | U `write.floor`, `snap.cut` (both pinned), `abort.append`; C `snap.com`; G `snap.nomove` | without them outcomes are kept for ever, no log is dropped, no move is given up (a give-up is optional), a snapshot is cut only below the commit offset, never at it; `snap.nomove` is the finding below |
| what a snapshot keeps of a move | U `snap.f_imp`, `snap.f_can`, `snap.f_unf`; `snap.f_exp` (unbounded) | see the ablation: a snapshot need not keep these facts at these bounds |

**One finding from the survivors: DESIGN-V5 4.1's "no slot move is still copying from it" is spare here** (`G snap.nomove`, and the ablation drops it). In this model the copy reads the slot's state, and the snapshot keeps that state whole, so a group may drop its log under a move that is still copying. The rule is needed only if the copy streams the log's records rather than the slot's state, or if a snapshot does not keep every record a reader may still ask for (see Gaps). Reasoned from the model; not a real-log result.

By DEV-03's bar the composed model, as designed, is short (70% against 85%), for the same reason E-15 gave for the slot move alone (39%): the move as written has guards that are spare at small bounds. A model cut to its smallest rule set (`./run.sh union`, not run) would be the fair test of the bar, as E-17's mutants were.

## Ablation of the rules added at the crossing (DEV-10 (c))

The candidates are the 26 rules the crossing added (crossing.py, `ADDED`): the log drop's two guards and its 17 updates (16 fields a snapshot keeps, and the cut itself), and the floor and mark rules on E-17's write, refusal and carry paths. Two are pinned (above), so 24 are ablated, with every other rule of the model kept. E-17's procedure ([model/cabl.py](model/cabl.py)): drop each alone (pass 1, taken from the mutant runs, which are the same searches); drop greedily in model-text order, keeping a drop only if all 18 bounds still hold; then a final pass checks that each rule left breaks a property when dropped from the result. [results/ablation.md](results/ablation.md):

Bounds: `src`, `dst`, `read-src`, `read-dst`, `mark-src`, `mark-dst`, `remit-src`, `remit-dst`, `lock-src`, `lock-dst`, `giveup-src`, `giveup-dst`, `crash-src`, `crash-dst`, `floors-src`, `floors-dst`, `floore-src`, `floore-dst`.

Pinned (written, never dropped, not counted): `write.floor`, `snap.cut`.

| Rule | What it says | Dropped alone | In the smallest set | Kept because |
|---|---|---|---|---|
| `write.above` | E-20 sess: apply only at or above the session's floor | P3 on `floore-src` in 7 steps | **needed** | P3 on `floore-src` in 7 steps |
| `write.mark` | E-30 srchi-slot: a derived output applies only above the slot's mark | P8 on `remit-src` in 4 steps | **needed** | P8 on `remit-src` in 4 steps |
| `write.src` | E-30 srchi-slot: the source sequence is written in the output's own entry | P8 on `remit-src` in 4 steps | **needed** | P8 on `remit-src` in 4 steps |
| `refuse.above` | E-20 sess: a copy below the floor is answered stale, never judged; E-17's refusal reads the outcomes, and E-20 forgets them below the floor | P3 on `floors-src` in 6 steps | **needed** | P3 on `floors-src` in 6 steps |
| `final.floor` | E-20 sess: the session's floor | P3 on `floors-src` in 18 steps | **needed** | P3 on `floors-src` in 18 steps |
| `final.mark` | E-30 srchi-slot: the slot's mark | P8 on `remit-src` in 16 steps | **needed** | P8 on `remit-src` in 16 steps |
| `snap.com` | a snapshot is cut at or below the commit offset | P1 on `src` in 2 steps | **needed** | P1 on `src` in 2 steps |
| `snap.nomove` | DESIGN-V5 4.1: no slot move is still copying from it | nothing breaks | dropped |  |
| `snap.held` | which slots the group holds open | P6 on `src` in 13 steps | **needed** | P6 on `src` in 13 steps |
| `snap.seq` | each slot's sequence | P2 on `mark-src` in 5 steps | **needed** | P2 on `mark-src` in 5 steps |
| `snap.recs` | each slot's rows and records | P1 on `src` in 3 steps | **needed** | P1 on `src` in 3 steps |
| `snap.outs` | each slot's dedup outcomes | P3 on `src` in 5 steps | **needed** | P3 on `src` in 5 steps |
| `snap.floor` | the session floor | P3 on `floors-src` in 7 steps | **needed** | P3 on `floors-src` in 7 steps |
| `snap.tok` | each slot's highest lock token | P3 on `lock-src` in 5 steps | **needed** | P3 on `lock-src` in 5 steps |
| `snap.mark` | each slot's srchi-slot mark | P8 on `remit-src` in 5 steps | **needed** | P8 on `remit-src` in 5 steps |
| `snap.cfg` | the group's config | CF on `src` in 5 steps | **needed** | CF on `src` in 5 steps |
| `snap.f_exp` | the moves this group exports | no counterexample; the search stopped at the state limit on `giveup-src` (1,100,261 states) | **needed** | P1 on `src` in 21 steps |
| `snap.f_imp` | the moves this group imports | nothing breaks | dropped |  |
| `snap.f_cp` | which copies it holds, and their END | P1 on `dst` in 17 steps | **needed** | P1 on `dst` in 19 steps |
| `snap.f_fen` | its fences, with N | L7 on `giveup-src` in 12 steps | **needed** | L5 on `src` in 9 steps |
| `snap.f_can` | its cancels | nothing breaks | dropped |  |
| `snap.f_unf` | its unfences | nothing breaks | dropped |  |
| `snap.f_open` | its opens | P6 on `giveup-dst` in 17 steps | **needed** | P6 on `giveup-dst` in 19 steps |
| `snap.f_abort` | its aborts | P6 on `giveup-dst` in 17 steps | **needed** | P6 on `giveup-dst` in 17 steps |

Needed: 20 of 24. Greedy order (model text): `snap.nomove` dropped; `snap.f_imp` dropped; `snap.f_can` dropped; `snap.f_unf` dropped

**20 of the 24 are needed.** Every carried field of the snapshot is needed (the open slots, sequence, rows, outcomes, floor, lock token, mark and config), and so are the snapshot's record of the moves this group exported, its copies with their `END`, its fences, opens and aborts. The floor and mark rules on E-17's paths are needed (`refuse.above` is the fix above). Four are not: DESIGN-V5 4.1's `snap.nomove` (see the mutants), and three move facts a snapshot need not keep at these bounds: the moves the group imports, its cancels and its unfences. Once a later entry (`open`, `abort`, or the slot's held set) is kept, these say nothing more (reasoned).

**What it costs.** The log drop is not a new mechanism: every Raft row already has snapshots. But what a snapshot keeps is now a list of 13 fields, each with a counterexample, with one guard (cut only at or below the commit offset), and the floor and mark add 6 rules on paths E-20 and E-30 did not have (the refusal path, the carry by E-17's move, and the mark's two write rules). By DEV-10's count that is 20 rules at the crossing. The single experiments' own rules were not ablated again here (`./run.sh union`, not run), so this does not say which of their spare rules the crossing makes necessary.

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
- **One member fault on every bound run in full** (review). So there is one election per run, and no candidate is ever behind the log: Raft's log check, E-14's LC, and A-01's election rules never decide anything there. A lost disk never comes back on those bounds either (Z `rejoin`'s return is only on `all`). The review's `crash2-src` (two crashes) shows LC can fail there, but it is partial.
- **The snapshot is one per group** (review): every replica drops its log at the same moment, and a learner's catch-up is one step that holds the snapshot. A follower that lags behind a leader's snapshot, the case DESIGN-V5 4.1 and E-31's `END` exist for, cannot happen here.
- **The design runs of the first 12 small bounds were redone** on resuming: the copies made before the last edits to the model (the CF ghost) had other state digests, though the same counts. The later runs (`floor-*`, `twice-*`, `slots-*`, `heal2-src`) gave the same digests when two of them were re-run, so they were kept. (The review re-ran `slots-dst` and `heal2-src` once more: same states, steps and digests.)

## What this box cannot show

- **Only small bounds.** Two groups, four members, one move (two in `twice-*`), one member fault, one or two log drops, one or two writes. Python explores about 4,000 states a second here; the two largest bounds (`any`, `all`) stop at 2.5 million states and give safety only.
- **No time.** The model is about order, not speed: it says nothing about how long a move, a swap or a snapshot takes, or how big the carried set is (K-25).
- **Raft is abstract.** A group is one log with a committed prefix, one leader's tail and the tails lost leaders left. Terms, vote messages and the details of etcd's raft are E-14's, not checked again here.
- **Not a second checker.** E-15 compared two checkers on the slot move; this model has one. The port was checked against E-17's model state for state, which is the same harness.

## Reproduce

`./run.sh` re-runs every step (Python 3.13, standard library only; E-17's harness and E-16's and E-17's result files beside this folder). Each check runs under the study's heavy lock in pieces of at most about 25 minutes; big checkpoints stay in `$SP/e32b`. Machine and versions: [results/machine.txt](results/machine.txt). CPU used: about 10 CPU-hours: 8.6 recorded in the checkpoints (design runs 0.9, mutants 5.4, ablation 2.3) and about 1.5 in runs cut by restarts (the stop before resuming, and two runner changes that made a cut piece lose at most one bound). That is above the 8 aimed for. The overrun came from healing mutants that grow to the state limit (before the `unbounded` rule) and from the ablation's final pass, whose floor rules fail only on the last bounds; no bound was added after the six on resuming. The review's checks are `./run.sh review` (raw output in [results/review.txt](results/review.txt); about 1 CPU-hour, plus about 1 more in the review's first runs of the same checks).

## Review

A second agent reviewed this experiment on 2026-11-10 and tried to refute it: against the model's text, and by running it. The raw output of every check is in [results/review.txt](results/review.txt) (`./run.sh review`). The review changed the model in one way: it added three bounds ([model/cbounds.py](model/cbounds.py), `REVIEW`). No existing bound or rule changed, so no earlier result is affected; the new bounds were run, and the mutant and ablation sweeps were not re-run on them. It also added [model/creview.py](model/creview.py) (four planted bugs, and a probe for elections) and the `review` step of [run.sh](run.sh).

### 1. Is it really composed? Yes, at one member fault

The five things act on the same state: each group's one log (committed part and uncommitted tail), its leader, its caught-up replicas, and the members.

| Thing | Where (model text) | State it shares with the others |
|---|---|---|
| slot move | `export`, `import`, `copy`, `fence`, `final`, `open`, `abort`, `unfence`, `cancel_on_abort` (crossing.py) | appends to A's and B's logs; reads the other group's committed log |
| leader change | `member-crash`, `member-loses-disk`, `elect` (cworld.py, `_fault` and `succ`) | the leader field and the caught-up set; a new leader keeps any prefix of the old tail, so move, write and config entries in the tail can vanish |
| voter change | `add`, `promote`, `remove`, `surplus`, `dropl` (crossing.py); `catchup`, `commit` (cworld.py) | config entries in the same log; the committed config decides commits (a quorum of its voters) and elections |
| log drop | `snap` (crossing.py), `CDraft.cut` (cworld.py) | replaces the committed prefix of the same log; every fold (`held`, `top`, `outs`, `floor`, `hightok`, `mark`, `recs`, `config`) and every move guard (through `ents`) reads through it |
| dedup carry | `write`, `refuse`, `final`, and `snap`'s fields | outcomes, floor, highest token and mark are folded from the same log, carried into B's log by `final`, kept by `snap` |

Also shared: the log cap (12 entries a group), and the rule that only a group with a live leader acts.

**Which orders the bounds allow.** The search is breadth first over every step, so:
- The member fault can strike at any point, before, during or after the move. Healing starts only after it (it needs a gone voter), then interleaves with every move step and every write.
- The log drop can come at any point where the dropping group has a leader and a committed entry. It always cuts at the commit offset (the whole committed prefix).
- **One order is held out of every design run.** DESIGN-V5 4.1's guard `snap.nomove` is kept, so a source never drops its log between its `exporting` and B's committed final copy. On `src` that removes 29,336 of 56,060 states. A target is never held back (it never exports, except in `twice-*`). The README said "in any order" without this; now fixed.
- **Without the guard, every full bound where it changes anything holds** every property, with liveness: 9 bounds in the mutant run (G `snap.nomove`, survived) and 6 more in this review:

| Bound | States, guard kept (design) | States, guard dropped | Result | Run |
|---|---|---|---|---|
| `src` | 26,724 | 56,060 | every property holds | mutant run; review |
| `read-src`, `mark-src`, `remit-src`, `lock-src` | 49,360; 56,196; 51,180; 83,272 | 103,804; 114,922; 107,092; 170,378 | every property holds | mutant run |
| `giveup-src`, `crash-src` | 110,026; 162,142 | 189,306; 349,380 | every property holds | mutant run |
| `floors-src`, `floore-src` | 176,560; 176,560 | 361,316; 361,316 | every property holds | mutant run |
| `dst-src` | 30,882 | 66,978 | every property holds | review |
| `floor-src` | 323,504 | 664,342 | every property holds | review |
| `slots-src` | 264,308 | 560,368 | every property holds | review |
| `twice-src`, `twice-dst` | 336,916; 511,554 | 498,588; 637,830 | every property holds | review |
| `heal2-src` | 1,373,695 | 2,825,670 | every property holds (14 minutes) | review |

  On `dst` and `src-dst` the counts do not change (36,716 and 47,204), as expected: B drops there and never exports. The same holds by reasoning for the other 11 bounds where only B drops.
- **What no bound run in full allows.** A second member fault. So each run has one election, and no candidate is ever behind the log: the review's probe (`creview.py stale`) finds no such state on `src`, `dst`, `crash-src`, `crash-dst`, `giveup-dst`, or the first million states of `all`, and finds one in 5 steps on `crash2-src`. Also never: a lost disk that comes back (only `all`), E-17's deposition without a member fault (only `all`), or a follower that lags behind its group's snapshot (one snapshot per group; catch-up is one step).

### 2. Can the properties fail? Yes, but two of them only on bounds the review added

The mutant script mutates only rules written in the rule language. The review planted four bugs where it never looks: helper code where the log drop meets the move, the reader and Raft. Each is one edit in a copy of the model ([model/creview.py](model/creview.py)), run on `src` and then on the smallest bound that reaches it.

| Bug (one edit) | Kind | `src` | Smallest bound that reaches it |
|---|---|---|---|
| b1: `final_cp` loses its END check, so a bulk copy counts as the final copy (read by `final.once` and by `snap.nomove`) | drop a guard | **caught**: L5, L5b, L7 (the final copy is never sent, so the move and the write never finish) | `src` |
| b2: a snapshot keeps a copy fact without its `END(N)` (`strip`) | drop an update | holds: B never drops its log on `src` | `dst`: **caught**, P1 in 17 steps (B drops after opening; A's final copy lands again and replaces the rows) |
| b3: the reader's no-skip check ignores records kept only in a snapshot | drop a guard | holds (no reader) | `read-src`, `read-dst`: **not caught** (one write: nothing to skip). `read2-src`: **caught**, P4 in 7 steps; `read2-dst`: 13 steps |
| b4: elections lose Raft's log check | drop a guard | holds | `crash-src`: **not caught** (162,142 states). `crash2-src`: **caught**, LC in 6 steps |

So P1, P4, LC and the liveness goals bite. But **P4's "no gap" and LC did not bite on any bound the README ran.** P4 needs two records: the README's mutant G `read.next` (the reader's whole no-skip check) is equivalent on all 18 sweep bounds, and on `read2-src` it is caught in 6 steps. LC needs an election with a candidate behind the log, which needs a second member fault.

**The model as designed on the review's bounds** (in full unless marked): `read2-src` 484,256 states and `read2-dst` 487,332, every property holds, with liveness. `crash2-src` stopped at 3,000,001 states with no counterexample: partial, safety only, not a pass (a wider form, any voter crashing and coming back, also passed 3 million states). Two member faults are too big for one lock hold here.

One more blind spot, from the stored mutant table: flipping the floor's comparison (C `write.above`, C `refuse.above`: `>=` to `>`) is equivalent on all 18 sweep bounds, because in each of them the client sends its second write only after the first is answered. The review ran both flips on `floor-src` (two writes sent in any order; not in the sweep): C `refuse.above` is caught there (L7: once w2 applies carrying floor 1, w1 can never be answered), and C `write.above` is still equivalent (the lock-token fence stops w1 before the floor does). It would need two writes with equal tokens sent in any order, which no bound has (reasoned). So `>=` against `>` on the write path is untested.

### 3. Do the rules match what the single experiments ended on?

| Experiment, and what it ended on | In this model | Did the README say so? |
|---|---|---|
| E-15: the slot move with its five fixes (table versions by move, recovery ends a shut slot's part, recovery writes the table, the fence binds the target's incarnation, reopen in a new epoch) | **none of the five**: there is no slot table, no unclean recovery and no epoch. The move is E-17's, with E-17c's once guards and one decider (A-17 (4)) | yes, in part (the base is E-17's; E-15's property 9 not checked). The Verdict and the last line still claimed every E-15 property: **fixed** |
| E-14c, A-01 (5): grow before shrink | yes: `promote.odd`, `remove.four` | yes |
| A-01 (1) no campaign while a committed change is unapplied; (2) learners grant votes | **not modelled**: a config takes effect at every member at its commit | only as "Raft is abstract": **added** (table R) |
| A-01 (3) only a voter stands; Raft's log check | written; but at one member fault the log check never decides an election | **added** (table R, LC, Gaps) |
| E-16 `self`: five actions, 14 rules, links and partitions, up to two faults | the five actions with "gone" read as "down"; `add.cand` lost its "not marked gone" part; no links; one fault | no: it said "as written". **Fixed** (table C) |
| A-19: a member back with a new disk joins as a new replica | `add.new` is there, but such a return happens only on the partial `all` | in the bounds table only: **added** (table Z, Gaps) |
| E-20 `sess`: dedup, the floor on every judging path, outcomes forgotten below it, carried on a move; registry, expiry, a `stale` answer | dedup, the floor on `write` and (the fix) `refuse`, forgetting, carry. No registry, no expiry, no `stale` answer (the copy gets no answer), refusals not logged (E-17's way) | registry and expiry yes; it said the copy "is answered `stale`": **fixed** |
| E-37, A-28: checksum turns damage into a wipe; never vote under the old id | the second only (a new incarnation) | yes (K-24) |
| E-30 `srchi-slot`: 5 rules (`commit.acked`, `apply.above`, `apply.mark`, `fence.carry`, `open.carry`); properties ONCE, DONE, LOST | `write.mark`, `write.src`, and one carry (`final.mark`) for E-30's two; `commit.acked` replaced by a world rule (an output is sent only once the previous source record's output applied); LOST not checked | no: **added** (table A-05, properties) |
| E-31: a replica that lacks the next record answers `END`; only the holding group's leader says `expired` | **not modelled**: no replica lags, and there is no `END`, `expired`, `moved` or `retry`. The reader is E-17's | only for the store tier (K-21): **added** (table O/W, properties) |
| A-17 (2): the carried set (sequence and epoch, outcomes and every session's floor, the lock fence table, marks, segment names) | one session's floor, the highest token, no epoch, no lock table, no segment names | yes (Gaps K-16, K-21) |

Added at the crossing and said: `refuse.above`, the snapshot's fields, the floor and mark carries, E-30's `dup` answer (pinned), the one-write-at-a-time client. Added and not said before: the in-order sending of derived outputs (above), and "only a group with a live leader acts" (Raft; cworld.py's notes said it).

### 4. Do the numbers reproduce? Yes, exactly

| Run | README | Re-run by the review |
|---|---|---|
| `src` (smallest) | 26,724 states, 53,747 steps, all hold | the same, and the same state digest |
| `slots-dst` (run before the model's last edits) | 234,540, 478,917 | the same, same digest |
| `heal2-src` (larger; run before the last edits, never re-run) | 1,373,695, 3,327,956 | the same, same digest (433 s) |
| step 1: the port against E-17's six bounds | the same counts | the same |
| the found counterexample; `snap.floor` on `floore-dst`; `final.mark` on `remit-src` | 6, 20 and 16 steps | the same |
| mutant tallies per action | 95 of 136; 64 of 75; 14 of 35; 11 of 20 | the same, counted from [results/mutants.md](results/mutants.md) |

### 5. The last line

It claimed every property of E-14, E-15, E-16, E-20, E-30 and E-31, "in any order", and "K-01 and K-02 now inside one model". The runs show less: E-15's 9 and E-31's protocol are not in the model; LC and P4's "no gap" could not fail on the README's bounds; one order (the source's drop mid-move) is held out of the design runs (and holds when let in); K-02 is in only in part; and each partial bound is named as not a pass. The Verdict and the last line now say this.

## Verdict

**The riskiest crossing the slot rows share holds, at these bounds, once three things are written down.** With COMP's picks and the fixes each experiment ended on, a slot move survives a leader change, a voter swap in either group, a log drop and the dedup carry, interleaved freely, with every property this model checks (model-checked here): E-15's 1 to 8, E-14's QL, LC and CF, E-16's P2, P3 and P8, E-20's ONCE and REFUSED, E-30's ONCE and DONE, and E-17's reader cursor. The design runs hold one order out (a source dropping its log while a move copies from it); the review let it in on every full bound it touches, and every property still holds. Two limits stand (review): every bound run in full has one member fault, so no election ever meets a voter behind the log (the two-crash bound is partial); and E-15's slot table and recovery rules, and E-31's subscribe protocol, are not in this model. Composing found one counterexample that neither single model could find, a write both applied and refused, and its fix is a rule E-20 already had, put on one more path. It also made rules of three things no single experiment had: a snapshot keeps the floor, the outcomes, the mark and the highest lock token beside the rows; the move carries the floor and the mark beside the token E-17 already carried; and every path that judges a copy checks the floor first. None is a new mechanism, and DESIGN-V5 4.1 (what a snapshot keeps) and 4.3 (the floor on every judging path) should say them.

By Q-32's threshold this is not evidence against the rows that share the crossing: the one counterexample has a small fix with a precedent, and no counterexample needed the five things together. It is evidence for them on DEV-02, for the pairs inside this model: K-01 at one member fault, and K-02 in part (one session's floor, the highest lock token rather than a fence table, no epoch, no segment names). The model as designed misses DEV-03's mutant bar (70% against 85%) for the reason E-15 gave for the move alone, so DEV-03's mutant clause stays open for the slot move; the crossing's own actions reach it (85%).

Which rows this covers. It models C `self` (each group's leader heals) and D `sess`: COMP, and the slot rows that take both. MIN, MIN-P, MIN-TS, RUST, SRV, LEAN, RLOG, EMB-V8 and SIDE take `cent-co` as written; E-16 already moved them toward `self`, and this model covers them only if they take it. The `win` rows (DRAFT, LANE, SPLIT, SLOG) were not modelled; their dedup also forgets outcomes below a floor, so by reasoning they owe the same floor check on their refusal path.

Q-32 (b): yes at these bounds, within stated limits: one model with a slot move, a leader change, a voter swap in A or B, a log drop behind a snapshot and the carried dedup state, interleaved freely (the design runs keep DESIGN-V5 4.1's guard, so a source never drops its log while a move copies from it; without the guard all 15 full bounds it touches hold too), keeps every property it checks (E-15's 1 to 8 but not 9, E-14's QL, LC and CF, E-16's P2, P3 and P8, E-20's ONCE and REFUSED, E-30's ONCE and DONE, E-17's reader cursor; E-31's protocol and E-15's slot table are not in it) on 28 bounds in full (up to 2,612,006 states, each under an hour) and on the review's two reader bounds with two writes (in full), while 3 bounds are partial and not a pass (`any` and `all` at 2.5 million states, the review's two-crash bound at 3 million, no counterexample), so every bound run in full has one member fault and no election ever meets a voter behind the log; once three rules are written: E-20's floor guards every path that judges a copy, E-17's lock-token refusal included (a write both applied and refused in 6 steps without it, found by composing, no move needed; Raft thesis 6.3); a snapshot keeps the floor, outcomes, mark and highest lock token beside the rows (5 to 20 steps without each); and the move carries the floor and the mark (16 to 19 steps); 20 of the 24 rules added at the crossing are needed, DESIGN-V5 4.1's "no move still copying" is not, and 95 of 136 mutants are caught (70%, under DEV-03's 85%; 85% where dedup meets the move and the log drop); 4 bugs the review planted are all caught, 2 only on the review's bounds. Moves: COMP (and MIN, MIN-P, MIN-TS, RUST, SRV, LEAN, RLOG, EMB-V8, SIDE once they take C `self`) up on DEV-02 (K-01 inside one model at one member fault; K-02 in part: one session's floor, the highest token rather than a fence table, no epoch, no segment names), F-02 and P-08, +20 counted rules on DEV-10 and no new mechanism on DEV-01; DEV-03 up on its model clause, its mutant clause still open for the slot move; DRAFT, LANE, SPLIT, SLOG (`win`) not checked here, and owed the same floor rule by reasoning.
