------------------------------- MODULE MCstale2 -------------------------------
(***************************************************************************)
(* E-14: the behavior of MCstaleconfig.tla (two leaders in one term), run  *)
(* on fero's model with etcd's code rules (FeroRules). Scenario            *)
(* three+spare: voters A, B, C and a spare id D; A leads in term 2.        *)
(*                                                                         *)
(* A adds D (C1), then removes C (C2). B learns that C1 is committed but   *)
(* has not applied it; D applies C2. Then B campaigns with {A,B,C} and D  *)
(* with {A,B,D}.                                                           *)
(*                                                                         *)
(* With the design, s2's campaign is refused (CanCampaign: no committed    *)
(* configuration left to apply), so the script cannot go on: TLC reports a *)
(* deadlock at that step, with every invariant holding. With the mutant    *)
(* that drops that guard, TLC reports MoreThanOneLeaderInv.                *)
(***************************************************************************)
EXTENDS MCferoraft

\* The servers by role: A first leads, B (V2) and C are the other voters,
\* D is the spare id.
A == L0
B == V2
C == CHOOSE v \in InitVoters \ {A, B} : TRUE
D == CHOOSE v \in Joiners : TRUE

VARIABLE step

S(a, i, j) == [a |-> a, i |-> i, j |-> j]
R(i, j, t) == [a |-> "Recv", i |-> i, j |-> j, t |-> t]

\* A adds D as a voter (C1, index 3) and commits it with B.
Add4 == <<
    S("AddVoter", A, D), S("AE", A, B), S("Self", A, A), S("Ready", A, A),
    R(B, A, AppendEntriesRequest), R(B, A, AppendEntriesRequest), S("Ready", B, A),
    R(A, A, AppendEntriesResponse), R(A, B, AppendEntriesResponse),
    S("Advance", A, A), S("Apply", A, A) >>

\* A removes C (C2, index 4); B and D get it; it commits under C1.
Remove3 == <<
    S("Remove", A, C), S("AE", A, B), S("AE", A, D), S("Self", A, A), S("Ready", A, A),
    R(B, A, AppendEntriesRequest), R(B, A, AppendEntriesRequest), S("Ready", B, A),
    R(D, A, AppendEntriesRequest), R(D, A, AppendEntriesRequest), R(D, A, AppendEntriesRequest),
    S("Ready", D, A),
    R(A, A, AppendEntriesResponse), R(A, B, AppendEntriesResponse), R(A, D, AppendEntriesResponse),
    S("Advance", A, A), S("Apply", A, A) >>

\* A tells D the new commit index; D applies C2. B knows only that C1
\* (index 3) is committed, and has applied nothing.
Tell == <<
    S("AE", A, D), S("Ready", A, A), R(D, A, AppendEntriesRequest), S("Ready", D, A),
    S("Apply", D, D) >>

TwoLeaders == <<
    S("Timeout", B, B), S("RequestVote", B, B), S("RequestVote", B, C), S("Ready", B, B),
    R(C, B, RequestVoteRequest), R(C, B, RequestVoteRequest), S("Ready", C, C),
    R(B, B, RequestVoteResponse), R(B, C, RequestVoteResponse), S("BecomeLeader", B, B),
    S("Timeout", D, D), S("RequestVote", D, D), S("RequestVote", D, A), S("Ready", D, D),
    R(A, D, RequestVoteRequest), R(A, D, RequestVoteRequest), S("Ready", A, A),
    R(D, D, RequestVoteResponse), R(D, A, RequestVoteResponse), S("BecomeLeader", D, D) >>

Script == Add4 \o Remove3 \o Tell \o TwoLeaders

Do(x) ==
    CASE x.a = "AddVoter"     -> AddVoterF(x.i, x.j)
      [] x.a = "Remove"       -> RemoveF(x.i, x.j)
      [] x.a = "AE"           -> \E b, e \in matchIndex[x.i][x.j]+1..Len(log[x.i])+1 :
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

Stale2Init == FeroInit /\ step = 0
Stale2Next == /\ step < Len(Script)
              /\ Do(Script[step + 1])
              /\ step' = step + 1
              /\ UNCHANGED <<up, dead, faults, sentCommit>>
              /\ goalv' = (Goal)' /\ livev' = (LiveMajority)'
Stale2Spec == Stale2Init /\ [][Stale2Next]_<<allvars, step>>

\* K: the steps before B's campaign. With the design, no behavior of the
\* script gets past step K (PastTimeout holds and the deepest state is at
\* step K); with the mutant, TLC reports MoreThanOneLeaderInv.
K == Len(Add4 \o Remove3 \o Tell)
PastTimeout == step <= K
=============================================================================
