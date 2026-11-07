----------------------------- MODULE MCferolive -----------------------------
(***************************************************************************)
(* fero's E-14b model: E-14's MCferoraft.tla (which EXTENDS etcd's         *)
(* etcdraft.tla unmodified), with the coarsening the liveness sweep needs. *)
(* Written 2026-11-07.                                                     *)
(*                                                                         *)
(* Nothing of MCferoraft is changed: the membership rules, the faults, the *)
(* goal and the invariants are E-14's. This module only adds a next-state  *)
(* relation that leaves some interleavings out. Each reduction is a       *)
(* constant, and each run says which it uses:                             *)
(*                                                                         *)
(*  EagerReady: etcd's Ready step (persist, then release the messages) is *)
(*    taken at once: while some up server has unpersisted state or unsent *)
(*    messages, the only step is that server's Ready. Ready touches only  *)
(*    its own server's disk and moves its own messages into the network,  *)
(*    so it commutes with every other server's step, and it is always     *)
(*    enabled; a crash before Ready equals the step never having happened.*)
(*    So every state of the full model reaches, by Ready steps alone, a   *)
(*    state of this one, and from such a state the goal is reachable in   *)
(*    one model exactly when it is in the other (reasoned, README).       *)
(*    Faults happen only between Ready steps.                             *)
(*                                                                         *)
(*  BatchVote: a candidate sends its vote request to every member it has  *)
(*    no answer from, and with nothing in flight to or from it, in one    *)
(*    step. A request's content is fixed for a candidate's term (its log  *)
(*    cannot change while it is a candidate), so this is the shipped      *)
(*    per-member RequestVote steps taken back to back.                    *)
(*                                                                         *)
(*  EagerNet: while a message to an up server is in the network, the only *)
(*    step (after Ready) is to deliver one, in any order. So no server    *)
(*    acts, crashes or recovers while a message is in flight, and no      *)
(*    message overtakes a later step. This one is a coarsening, not an    *)
(*    exact reduction: it leaves out states where a message waits while   *)
(*    other servers act. Why it keeps the liveness verdicts in this       *)
(*    crash-only model is argued in the README, and it is checked against *)
(*    the model without it on runs that finish both ways.                 *)
(*                                                                         *)
(*  DeadView: TLC tells states apart by a view that blanks variables no   *)
(*    step can read before they are written again: the vote sets of a     *)
(*    server that is not a candidate (only a timeout makes it one, and it *)
(*    clears them), and the match indexes and sent-commit marks of a      *)
(*    server that is not a leader (becoming leader resets match indexes,  *)
(*    and a mark from an older term never equals the new term's). No      *)
(*    invariant reads them. Two states with the same view behave the      *)
(*    same, so this is exact.                                             *)
(***************************************************************************)
EXTENDS MCferoraft

CONSTANTS EagerReady, BatchVote, EagerNet, DeadView

\* planv: the healing plan is done (a second goal, read by tools/agef2.py).
VARIABLE planv

\* The durable record Ready would write for i now (etcdraft's PersistState).
DurableNow(i) == [currentTerm |-> currentTerm[i], votedFor |-> votedFor[i],
                  log |-> Len(log[i]), commitIndex |-> commitIndex[i],
                  config |-> config[i]]

\* i has state not yet persisted, or messages not yet released.
Dirty(i) == \/ durableState[i] # DurableNow(i)
            \/ \E m \in DOMAIN pendingMessages : m.msource = i

AnyDirty == \E i \in up : Dirty(i)

----
\* BatchVote: the shipped RequestVote(i, j) for every j at once.

RVMsg(i, j) ==
    IF i # j
    THEN [mtype |-> RequestVoteRequest, mterm |-> currentTerm[i],
          mlastLogTerm |-> LastTerm(log[i]), mlastLogIndex |-> Len(log[i]),
          msource |-> i, mdest |-> j]
    ELSE [mtype |-> RequestVoteResponse, mterm |-> currentTerm[i],
          mvoteGranted |-> TRUE, msource |-> i, mdest |-> i]

VoteInFlight(i, j) ==
    \E m \in DOMAIN messages \cup DOMAIN pendingMessages :
        /\ m.mtype \in {RequestVoteRequest, RequestVoteResponse}
        /\ m.mterm = currentTerm[i]
        /\ \/ m.msource = i /\ m.mdest = j
           \/ m.msource = j /\ m.mdest = i

\* A request to a member that is down is lost when sent (FeroSend's rule).
VoteTargets(i) == {j \in (GetConfig(i) \cup GetLearners(i)) \ votesResponded[i] :
                      j \in up /\ ~VoteInFlight(i, j)}

BroadcastVote(i) ==
    /\ state[i] = Candidate
    /\ VoteTargets(i) # {}
    /\ pendingMessages' = pendingMessages (+) SetToBag({RVMsg(i, j) : j \in VoteTargets(i)})
    /\ UNCHANGED <<messages, serverVars, candidateVars, leaderVars, logVars, configVars, durableState>>

----
\* MCferoraft's ServerStep and OtherStep, with RequestVote swapped for
\* BroadcastVote when BatchVote holds. Every other disjunct is E-14's.

LOtherStep ==
    \/ \E i, j \in up : ~BatchVote /\ RequestVote(i, j)
    \/ \E i \in up : BatchVote /\ BroadcastVote(i)
    \/ \E i \in up : IF FeroRules THEN FeroBecomeLeader(i) ELSE BecomeLeader(i)
    \/ \E i \in up : BClientRequest(i)
    \/ \E i \in up : AdvanceCommitIndex(i)
    \/ \E i \in up : /\ CoarseAE => matchIndex[i][i] < Len(log[i])
                     /\ AppendEntriesToSelf(i)
    \/ \E i, j \in up : ~CoarseAE /\ Heartbeat(i, j)
    \/ \E i, j \in up : \E index \in 1..commitIndex[i] : AllowSnapshot /\ SendSnapshot(i, j, index)
    \/ \E i \in up : BTimeout(i)
    \/ \E i \in up : ~EagerReady /\ Ready(i)
    \/ \E i \in up : ~EagerApply /\ IF FeroRules THEN FeroApplyConf(i) ELSE ApplySimpleConfChange(i)
    \/ \E i \in up : /\ EagerApply /\ FeroRules /\ state[i] = Leader /\ i \notin GetConfig(i)
                     /\ state' = [state EXCEPT ![i] = Follower]
                     /\ UNCHANGED <<messageVars, currentTerm, votedFor, candidateVars, leaderVars, logVars, configVars, durableState>>
    \/ \E i \in up, j \in Server :
            IF FeroRules THEN FeroConf(i, j) ELSE (i \in up /\ ShippedConf(i, j))

LServerStep ==
    \/ \E i, j \in up : \E b, e \in matchIndex[i][j]+1..Len(log[i])+1 :
            /\ CoarseAE => (b = matchIndex[i][j] + 1 /\ e = Len(log[i]) + 1)
            /\ CoarseAE => (matchIndex[i][j] < Len(log[i]) \/ sentCommit[i][j] # <<currentTerm[i], commitIndex[i]>>)
            /\ AppendEntries(i, j, <<b, e>>)
            /\ sentCommit' = [sentCommit EXCEPT ![i][j] = <<currentTerm[i], commitIndex[i]>>]
    \/ LOtherStep /\ UNCHANGED sentCommit

LProgress == \/ LServerStep /\ UNCHANGED <<up, dead, faults>>
             \/ Deliver /\ UNCHANGED <<up, dead, faults, sentCommit>>

ReadyStep == \E i \in up : Dirty(i) /\ Ready(i) /\ UNCHANGED <<up, dead, faults, sentCommit>>

DeliverStep == Deliver /\ UNCHANGED <<up, dead, faults, sentCommit>>

\* A message to an up server is in the network.
Deliverable == \E m \in DOMAIN messages : m.mdest \in up

LiveNext0 ==
    IF EagerReady /\ AnyDirty
    THEN ReadyStep
    ELSE IF EagerNet /\ Deliverable
    THEN DeliverStep
    ELSE \/ LServerStep /\ UNCHANGED <<up, dead, faults>>
         \/ ~EagerNet /\ DeliverStep
         \/ Fault /\ UNCHANGED sentCommit
         \/ \E i \in Server : Recover(i) /\ UNCHANGED sentCommit

\* Checked in the calibration runs: EagerNet never leaves a state with a
\* message in flight and no way to deliver it.
EagerNetOK == (EagerNet /\ ~AnyDirty /\ Deliverable) => ENABLED DeliverStep

----
\* The second goal: the scenario's healing plan is done, by a leader that
\* works (E-14's Goal), whose config is the plan's end state. It is judged
\* only from states with no fault used (tools/agef2.py), where no proposal
\* can be lost, so the change budget (ReconfigurationLimit) is enough.
\* This is healing.py's P8 in its simplest form: healing finishes when
\* nothing fails.
PlanTarget(V) ==
    CASE Plan = "swap"     -> InitLearners \subseteq V /\ V2 \notin V
      [] Plan = "demote"   -> V2 \notin V
      [] Plan = "grow"     -> InitLearners \subseteq V
      [] Plan = "stepback" -> V2 \notin V \/ InitLearners \subseteq V
      [] Plan = "replace"  -> Joiners \subseteq V /\ Cardinality(V) = Cardinality(InitVoters)
      [] OTHER             -> TRUE

PlanDone == Goal /\ \E l \in up : /\ state[l] = Leader
                                  /\ l \in GetConfig(l)
                                  /\ ConfApplied(l) \/ OnAppend
                                  /\ PlanTarget(GetConfig(l))

LiveNext == LiveNext0 /\ goalv' = (Goal)' /\ livev' = (LiveMajority)' /\ planv' = (PlanDone)'

LiveInit == FeroInit /\ planv = PlanDone

LiveSpec == LiveInit /\ [][LiveNext]_<<allvars, planv>>

----
\* DeadView (see the header). LView is E-14's FeroView with the dead
\* variables blanked when DeadView holds.
DVotes(v) == [i \in Server |-> IF DeadView /\ state[i] # Candidate THEN {} ELSE v[i]]
DMatch == [i \in Server |-> IF DeadView /\ state[i] # Leader THEN [j \in Server |-> 0] ELSE matchIndex[i]]
DSent == [i \in Server |-> IF DeadView /\ state[i] # Leader THEN [j \in Server |-> <<0, 0>>] ELSE sentCommit[i]]
LView == <<LiveBag(messages), LiveBag(pendingMessages), serverVars, DVotes(votesResponded), DVotes(votesGranted),
           DMatch, pendingConfChangeIndex, logVars, configVars, durableState, up, dead, faults, goalv, livev, DSent>>

\* A state is "settled" when no up server is dirty; with EagerReady only
\* settled states have more than one successor.
Settled == ~AnyDirty
=============================================================================
