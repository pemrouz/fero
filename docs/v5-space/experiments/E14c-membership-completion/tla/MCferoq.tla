------------------------------ MODULE MCferoq ------------------------------
(***************************************************************************)
(* E-14c's reduction for the liveness check: MCferoc.tla, unchanged, with  *)
(* four more bounds above the judged term, and one more flag.              *)
(* Written 2026-11-10.                                                     *)
(*                                                                         *)
(* The liveness check (tools/agef2.py, healing.py's P5 as AG EF) asks, for *)
(* every JUDGED state (highest term at most J): can a goal state still be  *)
(* reached by PROGRESS steps only? A progress step is one that is neither  *)
(* a fault nor a recovery: it keeps `faults` and the number of up servers. *)
(*                                                                         *)
(* Terms never go down. So every path to a judged state stays at terms up  *)
(* to J, and a step taken in a state whose highest term is above J can     *)
(* never lead to a judged state. Such steps matter to the check in one way *)
(* only: as part of a way out. Every bound below applies only above term   *)
(* J = ProgressAbove, and only removes steps. So:                          *)
(*  - the judged states are the same set as in the full model, each with   *)
(*    every step the full model gives it;                                  *)
(*  - every step kept is a step of the full model, so a way out found here *)
(*    is a way out of the full model: a PASS is sound, whatever the bounds.*)
(* A FAIL needs more: that no way out was cut off. That is argued per      *)
(* bound here, and checked on runs that finish with and without the bounds *)
(* (README, step 3).                                                       *)
(*                                                                         *)
(* Bound 1 (always on; cuts no way out). No fault and no recovery above    *)
(*   term J. The check never follows a fault or a recovery.                *)
(*                                                                         *)
(* Bound 2, NoConfAfterFault (may cut a way out; each FAIL is read). Above *)
(*   term J, once a fault has been used, no leader proposes a NEW          *)
(*   configuration change; changes already in a log still commit and       *)
(*   apply. Without it, a leader elected after the fault replays the whole *)
(*   healing plan in the new term. The plan goal is judged only where no   *)
(*   fault was used, so this bound never touches it.                       *)
(*                                                                         *)
(* Bound 3, Canon (cuts no way out, up to the order of independent steps). *)
(*   Above term J, E-14b's two eager steps are taken in one fixed order:   *)
(*   when several servers have a Ready step to take, one chosen server     *)
(*   takes it; when several messages can be delivered, one chosen message  *)
(*   is. E-14b's reductions R1 and R4 already say that only these steps    *)
(*   may happen then, "in any order". Ready steps of different servers     *)
(*   touch different servers' state, and so do deliveries to different     *)
(*   servers, so every order ends in the same state; the orders differ     *)
(*   only in the states they pass through. With k followers answering a    *)
(*   vote request or an append, the passing states grow as a power of k.   *)
(*   That was most of the state space above term J.                        *)
(*                                                                         *)
(* Bound 4, StopAtGoal (cuts no way out). Above term J a state where the   *)
(*   question is already answered has no steps: a working leader after a   *)
(*   fault (the plan goal is not judged there), or the plan done.          *)
(*                                                                         *)
(* What is left out by all four: states above term J. The invariants are   *)
(* checked only on the states a run visits.                                *)
(*                                                                         *)
(* The flag openv: the change budget still allows the healing plan. Two    *)
(* of E-14b's plans can be wasted by the leader's own choices: "swap" by   *)
(* demoting V2 and then removing it (both changes spent, the learner not   *)
(* promoted), "replace" by removing two voters. From such a state no rule  *)
(* could finish the plan, so tools/agef2.py judges the plan goal only      *)
(* where openv holds, and counts the others apart. openv is a function of  *)
(* the other variables wherever no fault was used (there the longest log   *)
(* holds every proposal), so it is left out of TLC's view.                 *)
(***************************************************************************)
EXTENDS MCferoc

CONSTANTS ProgressAbove, NoConfAfterFault, Canon, StopAtGoal

VARIABLE openv

\* The highest term any server holds (what tools/dotfilter.py reads as a
\* state's term).
HighTerm == Max({currentTerm[i] : i \in Server})
Above == HighTerm > ProgressAbove

----
\* The plan-open flag.

\* The voters of the last configuration any leader proposed: with no fault
\* used, logs are prefixes of the longest one, which holds every proposal.
Longest == CHOOSE x \in Server : \A y \in Server : Len(log[x]) >= Len(log[y])
LastProposed == AppendConf(Longest).jointConfig[1]

\* How many more changes the plan needs from voters V, at the least.
PlanNeed(V) ==
    CASE Plan = "swap"    -> Cardinality(InitLearners \ V) + Cardinality({V2} \cap V)
      [] Plan = "replace" -> LET n == Cardinality(V) + Cardinality(Joiners \ V)
                             IN  IF n < Cardinality(InitVoters)
                                 THEN ReconfigurationLimit + 1      \* too few voters left: never
                                 ELSE Cardinality(Joiners \ V) + (n - Cardinality(InitVoters))
      [] OTHER            -> 0

PlanOpen == PlanNeed(LastProposed) <= ReconfigurationLimit - reconfigCount

----
\* Bound 3: one fixed order for the eager steps.

DeliverMsg(m) ==
    /\ m.mdest \in up
    /\ (IF FeroRules THEN FeroReceive(m) ELSE Receive(m)) \/ FeroRefuseVote(m)
    /\ UNCHANGED <<up, dead, faults, sentCommit>>

\* The chosen message: one that can be delivered now.
CanDeliver(m) == ENABLED DeliverMsg(m)
QDeliver ==
    /\ \E m \in DOMAIN messages : CanDeliver(m)
    /\ DeliverMsg(CHOOSE m \in DOMAIN messages : CanDeliver(m))

QReady ==
    /\ Ready(CHOOSE x \in up : Dirty(x))
    /\ UNCHANGED <<up, dead, faults, sentCommit>>

\* E-14b's LiveNext0 without Fault and Recover (bound 1), with the eager
\* steps in one order (bound 3). Every disjunct is a case of LiveNext0.
QAbove0 ==
    IF EagerReady /\ AnyDirty
    THEN QReady
    ELSE IF EagerNet /\ Deliverable
    THEN QDeliver
    ELSE \/ LServerStep /\ UNCHANGED <<up, dead, faults>>
         \/ ~EagerNet /\ DeliverStep

\* Bound 4: the question is answered in this state.
Answered == \/ faults > 0 /\ goalv
            \/ planv

QNext0 ==
    IF Above
    THEN /\ ~(StopAtGoal /\ Answered)
         /\ IF Canon THEN QAbove0 ELSE LiveNext0
         \* bound 1, as tools/agef2.py tests a progress step
         /\ faults' = faults
         /\ Cardinality(up') = Cardinality(up)
         \* bound 2
         /\ (NoConfAfterFault /\ faults > 0) => reconfigCount' = reconfigCount
    ELSE LiveNext0

QInit == CInit /\ openv = PlanOpen

\* The flags and the history variable follow every step, as in LiveNext and CNext.
QNext ==
    /\ QNext0
    /\ goalv' = (Goal)'
    /\ livev' = (LiveMajority)'
    /\ planv' = (PlanDone)'
    /\ CtlNext
    /\ openv' = (PlanOpen)'

QSpec == QInit /\ [][QNext]_<<allvars, planv, ctl, openv>>

=============================================================================
