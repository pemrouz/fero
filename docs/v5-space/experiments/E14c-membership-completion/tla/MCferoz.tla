------------------------------ MODULE MCferoz ------------------------------
(***************************************************************************)
(* E-14c: MCferoq.tla with two more bounds above the judged term, so that  *)
(* the liveness runs for three-disk and four finish. Written 2026-11-10.   *)
(*                                                                         *)
(* MCferoq's four bounds were not enough: with them, each state that       *)
(* enters term 3 still fanned out into the order in which a leader's       *)
(* independent steps happen (append to this follower or that one first,    *)
(* commit now or later, who applies a configuration first), and three      *)
(* servers could each stand. The liveness check needs ONE way out per      *)
(* judged state. So, above the judged term J only:                         *)
(*                                                                         *)
(* Bound 5, one candidate that can win. Of the servers that could stand,   *)
(*   one chosen server may: one whose vote request a quorum of its own     *)
(*   configuration, all up, would grant (their logs are no more up to date *)
(*   than its own, and their terms no higher). This also applies to the    *)
(*   timeout that leaves term J. If no server can win, nobody stands.      *)
(*                                                                         *)
(* Bound 6, one schedule. The steps that involve no choice are taken in a  *)
(*   fixed order, one chosen server at a time: apply a committed           *)
(*   configuration, become leader, commit, the leader's own append, an     *)
(*   append to a follower, a candidate's vote request. Only when none of   *)
(*   these can change anything does a server stand (bound 5) or a leader   *)
(*   propose a change (any change the plan allows: all are tried).         *)
(*                                                                         *)
(* Like MCferoq's bounds, these apply only above term J and only remove    *)
(* steps. So the judged states are the full model's, and a way out found   *)
(* here is a way out of the full model: a PASS is sound. A FAIL is not     *)
(* proof by itself: the fixed schedule could have cut the way out off. So  *)
(* every stuck state is sorted by kind and read (tools/classify.py), and   *)
(* the bounds are checked on scenarios that finish in full (README).       *)
(*                                                                         *)
(* Why the schedule should cut no way out (reasoned): once it is settled   *)
(* who stands, Raft has no more choices; the steps of bound 6 only carry   *)
(* out what the vote and the logs already decide, and each commutes with   *)
(* the others or enables them. Delaying one never helps reach a working    *)
(* leader: a leader must apply its committed configuration before it       *)
(* counts as working, and a follower may not stand before it has applied.  *)
(***************************************************************************)
EXTENDS MCferoq

\* The schedule below spells out E-14b's step relation for these settings.
ASSUME /\ BatchVote /\ FeroRules /\ CoarseAE /\ EagerReady /\ EagerNet
       /\ ~EagerApply /\ ~AllowSnapshot /\ RequestLimit = 0

Frame == UNCHANGED <<sentCommit, up, dead, faults>>

\* The steps with no choice in them: LOtherStep's and LServerStep's
\* disjuncts, one server (or pair) at a time.
ZApply(i)  == FeroApplyConf(i) /\ Frame
ZLead(i)   == FeroBecomeLeader(i) /\ Frame
ZCommit(i) == AdvanceCommitIndex(i) /\ Frame
ZSelf(i)   == matchIndex[i][i] < Len(log[i]) /\ AppendEntriesToSelf(i) /\ Frame
ZVote(i)   == BroadcastVote(i) /\ Frame
ZAppend(i, j) ==
    /\ matchIndex[i][j] < Len(log[i]) \/ sentCommit[i][j] # <<currentTerm[i], commitIndex[i]>>
    /\ AppendEntries(i, j, <<matchIndex[i][j] + 1, Len(log[i]) + 1>>)
    /\ sentCommit' = [sentCommit EXCEPT ![i][j] = <<currentTerm[i], commitIndex[i]>>]
    /\ UNCHANGED <<up, dead, faults>>

\* A step counts only if it changes something (a leader's commit step is
\* always enabled, and often changes nothing).
zv == <<vars, sentCommit>>
EApply  == {i \in up : ENABLED <<ZApply(i)>>_zv}
ELead   == {i \in up : ENABLED <<ZLead(i)>>_zv}
ECommit == {i \in up : ENABLED <<ZCommit(i)>>_zv}
ESelf   == {i \in up : ENABLED <<ZSelf(i)>>_zv}
EVote   == {i \in up : ENABLED <<ZVote(i)>>_zv}
EAppend == {p \in up \X up : ENABLED <<ZAppend(p[1], p[2])>>_zv}

\* Bound 5: a server whose vote request a quorum of its own configuration
\* would grant.
Winnable(i) ==
    \E Q \in Quorum(GetConfig(i)) :
        /\ Q \subseteq up
        /\ \A j \in Q : j = i \/ (~RefusesLog(j, i) /\ currentTerm[j] <= currentTerm[i])

ZTimeout(i) == BTimeout(i) /\ Frame
Cands == {i \in up : Winnable(i) /\ ENABLED ZTimeout(i)}

\* The steps with a choice in them: who stands (one chosen server that can
\* win), and which change a leader proposes (all of them).
ZChoice ==
    \/ Cands # {} /\ ZTimeout(CHOOSE i \in Cands : TRUE)
    \/ \E i \in up, j \in Server : FeroConf(i, j) /\ Frame

\* Bound 6: the fixed order.
ZQuiet ==
    IF EApply # {} THEN ZApply(CHOOSE i \in EApply : TRUE)
    ELSE IF ELead # {} THEN ZLead(CHOOSE i \in ELead : TRUE)
    ELSE IF ECommit # {} THEN ZCommit(CHOOSE i \in ECommit : TRUE)
    ELSE IF ESelf # {} THEN ZSelf(CHOOSE i \in ESelf : TRUE)
    ELSE IF EAppend # {} THEN (LET p == CHOOSE q \in EAppend : TRUE IN ZAppend(p[1], p[2]))
    ELSE IF EVote # {} THEN ZVote(CHOOSE i \in EVote : TRUE)
    ELSE ZChoice

ZAbove0 ==
    IF AnyDirty THEN QReady
    ELSE IF Deliverable THEN QDeliver
    ELSE ZQuiet

ZNext0 ==
    IF Above
    THEN /\ ~(StopAtGoal /\ Answered)
         /\ ZAbove0
         \* bound 2 (bound 1 is built in: ZAbove0 has no fault and no recovery)
         /\ (NoConfAfterFault /\ faults > 0) => reconfigCount' = reconfigCount
    ELSE /\ LiveNext0
         \* bound 5 for the timeout that leaves the judged term
         /\ (HighTerm)' > ProgressAbove =>
                (Cands # {} /\ currentTerm'[CHOOSE i \in Cands : TRUE] > ProgressAbove)

ZNext ==
    /\ ZNext0
    /\ goalv' = (Goal)'
    /\ livev' = (LiveMajority)'
    /\ planv' = (PlanDone)'
    /\ CtlNext
    /\ openv' = (PlanOpen)'

ZSpec == QInit /\ [][ZNext]_<<allvars, planv, ctl, openv>>

=============================================================================
