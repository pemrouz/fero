----------------------------- MODULE MCr21script -----------------------------
(***************************************************************************)
(* E-14: healing.py's R2-1 state, on commit: one scripted way out.         *)
(*                                                                         *)
(* Start (InitR21): leader A appended "demote B" in term 2, sent it to B   *)
(* alone, and is gone. B holds the longest log. On append, B is a learner  *)
(* in its own eyes, never stands, and refuses C and D its vote: stuck (run *)
(* r21-append-ef finds no goal state at all). On commit, B is still a      *)
(* voter: it stands and wins, commits the demotion with its empty entry,   *)
(* applies it and steps down; C then wins under {A, C, D} and commits.     *)
(* TLC reports NotGoal violated at the last step: the goal is reached.     *)
(***************************************************************************)
EXTENDS MCferoraft

A == L0
B == V2
C == CHOOSE v \in InitVoters \ {A, B} : TRUE
D == CHOOSE v \in InitVoters \ {A, B, C} : TRUE

VARIABLE step

S(a, i, j) == [a |-> a, i |-> i, j |-> j]
R(i, j, t) == [a |-> "Recv", i |-> i, j |-> j, t |-> t]

ElectB == <<
    S("Timeout", B, B), S("RequestVote", B, B), S("RequestVote", B, C), S("RequestVote", B, D), S("Ready", B, B),
    R(C, B, RequestVoteRequest), R(C, B, RequestVoteRequest), S("Ready", C, C),
    R(D, B, RequestVoteRequest), R(D, B, RequestVoteRequest), S("Ready", D, D),
    R(B, B, RequestVoteResponse), R(B, C, RequestVoteResponse), R(B, D, RequestVoteResponse),
    S("BecomeLeader", B, B) >>

\* After an election the leader's match index is 0, so its first append is
\* answered with the follower's commit index; the second carries the tail.
Catch(l, f) == <<
    S("AE", l, f), S("Ready", l, l), R(f, l, AppendEntriesRequest), S("Ready", f, f), R(l, f, AppendEntriesResponse),
    S("AE", l, f), S("Ready", l, l), R(f, l, AppendEntriesRequest), R(f, l, AppendEntriesRequest), S("Ready", f, f),
    R(l, f, AppendEntriesResponse) >>

\* B replicates the demotion and its empty entry, commits both under
\* {A, B, C, D} with C and D, tells C, applies the demotion and steps down.
CommitB == <<S("Self", B, B), S("Ready", B, B), R(B, B, AppendEntriesResponse)>>
           \o Catch(B, C) \o Catch(B, D) \o
           << S("Advance", B, B), S("AE", B, C), S("Ready", B, B), R(C, B, AppendEntriesRequest), S("Ready", C, C),
              S("Apply", B, B), S("Apply", C, C) >>

\* C stands under {A, C, D}, wins with D, and commits its empty entry.
ElectC == << S("Timeout", C, C), S("RequestVote", C, C), S("RequestVote", C, D), S("Ready", C, C),
             R(D, C, RequestVoteRequest), R(D, C, RequestVoteRequest), S("Ready", D, D),
             R(C, C, RequestVoteResponse), R(C, D, RequestVoteResponse), S("BecomeLeader", C, C),
             S("Self", C, C), S("Ready", C, C), R(C, C, AppendEntriesResponse) >>
          \o Catch(C, D) \o << S("Advance", C, C) >>

Script == ElectB \o CommitB \o ElectC

\* How far the script got (TLC prints the depth); a run that stops short of
\* Len(Script) without reaching the goal names the step that was refused.
Reached == step

Do(x) ==
    CASE x.a = "AE"           -> \E b, e \in matchIndex[x.i][x.j]+1..Len(log[x.i])+1 :
                                    /\ b = matchIndex[x.i][x.j] + 1 /\ e = Len(log[x.i]) + 1
                                    /\ AppendEntries(x.i, x.j, <<b, e>>)
      [] x.a = "Self"         -> AppendEntriesToSelf(x.i)
      [] x.a = "Ready"        -> Ready(x.i)
      [] x.a = "Advance"      -> AdvanceCommitIndex(x.i)
      [] x.a = "Apply"        -> FeroApplyConf(x.i)
      [] x.a = "Timeout"      -> BTimeout(x.i)
      [] x.a = "RequestVote"  -> RequestVote(x.i, x.j)
      [] x.a = "BecomeLeader" -> FeroBecomeLeader(x.i)
      [] x.a = "Recv"         -> \E m \in DOMAIN messages :
                                    /\ m.mdest = x.i /\ m.msource = x.j /\ m.mtype = x.t
                                    /\ FeroReceive(m)

ScrInit == FeroInit /\ step = 0
ScrNext == /\ step < Len(Script)
           /\ Do(Script[step + 1])
           /\ step' = step + 1
           /\ UNCHANGED <<up, dead, faults, sentCommit>>
           /\ goalv' = (Goal)' /\ livev' = (LiveMajority)'
ScrSpec == ScrInit /\ [][ScrNext]_<<allvars, step>>
=============================================================================
