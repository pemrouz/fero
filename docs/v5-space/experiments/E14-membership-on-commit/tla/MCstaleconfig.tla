---------------------------- MODULE MCstaleconfig ----------------------------
(***************************************************************************)
(* E-14: one scripted behavior of etcd's etcdraft.tla, unmodified, with    *)
(* MCetcdraft's own initial state and action wrappers. Each step names a   *)
(* shipped action and its servers; TLC checks every step is enabled and    *)
(* checks the shipped invariants at every state on the way.                *)
(*                                                                         *)
(* The behavior: leader 1 adds 4, then removes 3. Server 2 learns that     *)
(* both changes committed but has not applied them yet (applying is a     *)
(* separate step in the spec, as in etcd). The spec lets 2 campaign with   *)
(* its old configuration {1,2,3}, while 4 campaigns with {1,2,4}.          *)
(* etcd's raft.go refuses this campaign (hup: "cannot campaign ... since   *)
(* there are still pending configuration changes to apply"); the spec has  *)
(* no such guard.                                                          *)
(***************************************************************************)
EXTENDS MCetcdraft

\* The servers: MCetcdraft.cfg's Server = {s1, s2, s3, s4} are model values;
\* the cfg here binds these constants to them so the script can name them.
CONSTANTS s1, s2, s3, s4

VARIABLE step

\* One scripted step: an action name and its servers.
S(a, i, j) == [a |-> a, i |-> i, j |-> j]
R(i, j, t) == [a |-> "Recv", i |-> i, j |-> j, t |-> t]

\* Leader 1 is elected in term 2.
Elect1 == <<
    S("Timeout", s1, s1), S("RequestVote", s1, s1), S("RequestVote", s1, s2), S("Ready", s1, s1),
    R(s2, s1, RequestVoteRequest), R(s2, s1, RequestVoteRequest), S("Ready", s2, s1),
    R(s1, s1, RequestVoteResponse), R(s1, s2, RequestVoteResponse), S("BecomeLeader", s1, s1) >>

\* 1 adds 4 as a voter (index 4), and commits it with 2.
Add4 == <<
    S("AddNewServer", s1, s4), S("AppendEntries", s1, s2), S("AppendEntriesToSelf", s1, s1), S("Ready", s1, s1),
    R(s2, s1, AppendEntriesRequest), R(s2, s1, AppendEntriesRequest), S("Ready", s2, s1),
    R(s1, s1, AppendEntriesResponse), R(s1, s2, AppendEntriesResponse),
    S("AdvanceCommitIndex", s1, s1), S("ApplySimpleConfChange", s1, s1) >>

\* 1 removes 3 (index 5), sends everything to 4 and the tail to 2, and
\* commits it with 2 and 4 under {1,2,3,4}.
Remove3 == <<
    S("DeleteServer", s1, s3), S("AppendEntries", s1, s2), S("AppendEntries", s1, s4),
    S("AppendEntriesToSelf", s1, s1), S("Ready", s1, s1),
    R(s2, s1, AppendEntriesRequest), R(s2, s1, AppendEntriesRequest), S("Ready", s2, s1),
    R(s4, s1, AppendEntriesRequest), R(s4, s1, AppendEntriesRequest), R(s4, s1, AppendEntriesRequest), S("Ready", s4, s1),
    R(s1, s1, AppendEntriesResponse), R(s1, s2, AppendEntriesResponse), R(s1, s4, AppendEntriesResponse),
    S("AdvanceCommitIndex", s1, s1), S("ApplySimpleConfChange", s1, s1) >>

\* 1 tells 4 the commit index; 4 applies {1,2,4}. 2 knows index 4 is
\* committed but applies nothing.
Tell == <<
    S("Heartbeat", s1, s4), S("Ready", s1, s1), R(s4, s1, AppendEntriesRequest), S("Ready", s4, s1),
    S("ApplySimpleConfChange", s4, s1) >>

\* 2 campaigns with {1,2,3} and wins with 3's vote; 4 campaigns with
\* {1,2,4} and wins with 1's vote. Both in term 3.
TwoLeaders == <<
    S("Timeout", s2, s1), S("RequestVote", s2, s2), S("RequestVote", s2, s3), S("Ready", s2, s1),
    R(s3, s2, RequestVoteRequest), R(s3, s2, RequestVoteRequest), S("Ready", s3, s1),
    R(s2, s2, RequestVoteResponse), R(s2, s3, RequestVoteResponse), S("BecomeLeader", s2, s1),
    S("Timeout", s4, s1), S("RequestVote", s4, s4), S("RequestVote", s4, s1), S("Ready", s4, s1),
    R(s1, s4, RequestVoteRequest), R(s1, s4, RequestVoteRequest), S("Ready", s1, s1),
    R(s4, s4, RequestVoteResponse), R(s4, s1, RequestVoteResponse), S("BecomeLeader", s4, s1) >>

Script == Elect1 \o Add4 \o Remove3 \o Tell \o TwoLeaders

Do(x) ==
    CASE x.a = "Timeout"              -> MCTimeout(x.i)
      [] x.a = "RequestVote"          -> RequestVote(x.i, x.j)
      [] x.a = "Ready"                -> Ready(x.i)
      [] x.a = "BecomeLeader"         -> BecomeLeader(x.i)
      [] x.a = "AddNewServer"         -> MCAddNewServer(x.i, x.j)
      [] x.a = "DeleteServer"         -> MCDeleteServer(x.i, x.j)
      [] x.a = "AppendEntries"        -> \E b, e \in matchIndex[x.i][x.j]+1..Len(log[x.i])+1 :
                                            /\ e = Len(log[x.i]) + 1
                                            /\ AppendEntries(x.i, x.j, <<b, e>>)
      [] x.a = "AppendEntriesToSelf"  -> AppendEntriesToSelf(x.i)
      [] x.a = "Heartbeat"            -> Heartbeat(x.i, x.j)
      [] x.a = "AdvanceCommitIndex"   -> AdvanceCommitIndex(x.i)
      [] x.a = "ApplySimpleConfChange" -> ApplySimpleConfChange(x.i)
      [] x.a = "Recv"                 -> \E m \in DOMAIN messages :
                                            /\ m.mdest = x.i /\ m.msource = x.j /\ m.mtype = x.t
                                            /\ Receive(m)

ScriptInit == Init /\ step = 0
ScriptNext == /\ step < Len(Script)
              /\ Do(Script[step + 1])
              /\ step' = step + 1
ScriptSpec == ScriptInit /\ [][ScriptNext]_<<vars, step>>

\* Reached the end of the script (TLC reports it, to show every step ran).
NotDone == step < Len(Script)
=============================================================================
