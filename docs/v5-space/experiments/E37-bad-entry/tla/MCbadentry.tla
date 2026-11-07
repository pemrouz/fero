----------------------------- MODULE MCbadentry -----------------------------
(***************************************************************************)
(* E-37: one voter keeps its id but loses or corrupts one fsynced entry   *)
(* below the commit point. Written 2026-11-07.                             *)
(*                                                                         *)
(* It EXTENDS E-14b's MCferolive (copied unchanged into this folder),      *)
(* which EXTENDS E-14's MCferoraft, which EXTENDS etcd's etcdraft.tla      *)
(* unchanged. So Raft, etcd's membership rules, the faults, the goal and  *)
(* E-14b's reductions are theirs. This module adds:                        *)
(*                                                                         *)
(*  - DamageRestart(i, k): a fault. Server i restarts and its disk returns *)
(*    entry k of its log damaged. k is at or below the commit index i had *)
(*    persisted (so i acknowledged it and knew it committed), and is not   *)
(*    the genesis entry. What i does next is the storage-fault option     *)
(*    (ZMode, SPACE axis Z):                                               *)
(*      "cut"    Raft as published plus F-10's "a torn tail is cut": no    *)
(*               checksum tells mid-log damage from a torn tail, so i cuts *)
(*               its log at k (and its commit index with it) and carries  *)
(*               on under its id. Z `crash`, as most Raft systems run.     *)
(*      "silent" no checksum, and the damage is a flip inside the entry's *)
(*               value: i reads a wrong value as if it were right.         *)
(*      "rejoin" a checksum per entry finds the damage; i wipes its disk  *)
(*               and returns as a new replica (a new incarnation), which  *)
(*               never votes as the old one: E-14's lost disk. Z `rejoin`, *)
(*               DESIGN-V5 4.1.                                            *)
(*      "ghost"  the same wipe, but i comes back under its old id (the    *)
(*               incarnation rule left out).                               *)
(*      "par"    a checksum per entry finds the damage; i keeps its id    *)
(*               and the rest of its log, marks entry k bad, and follows  *)
(*               the fix rules below until a peer repairs it. The cheapest *)
(*               form of Z `par` (QUESTIONS Q-37).                         *)
(*  - A ghost, `ghost`: the longest log ever committed. NoLostCommit asks *)
(*    that every server's committed prefix agrees with it and every       *)
(*    leader of a later term holds it: no committed entry is ever lost or *)
(*    changed, judged across time, not only in one state.                 *)
(*  - The 8 shipped invariants, read through TrueLog: in "par" a bad slot *)
(*    is read as the committed entry it held (the data the cluster can    *)
(*    still repair), so only damage that spreads, or a vote or lead built *)
(*    on it, shows as a violation.                                         *)
(***************************************************************************)
EXTENDS MCferolive

CONSTANTS ZMode, DamageLimit, DistinctOffsets, RepairFrom, DamageLeaderOnly, NoCrash

VARIABLES bad,      \* [Server -> Nat]: the index i's checksum found bad (0: none). "par" only.
          ghost,    \* the longest log ever committed (a ghost)
          damaged   \* the set of <<server, index>> damaged so far (a ghost: bounds and reports)

zvars == <<bad, ghost, damaged>>

\* A zeroed record: what a damaged slot reads as (term 0, a wrong value).
BadEntry == [term |-> 0, type |-> ValueEntry, value |-> [val |-> 7]]

\* What i's log held: the bad slot read as the committed entry it was.
TrueLog(i) == IF bad[i] = 0 \/ bad[i] > Len(log[i]) \/ bad[i] > Len(ghost)
              THEN log[i]
              ELSE [log[i] EXCEPT ![bad[i]] = ghost[bad[i]]]
TCommitted(i) == SubSeq(TrueLog(i), 1, Min({commitIndex[i], Len(TrueLog(i))}))

----
\* MUTATE-BEGIN. The fix (ZMode "par"): a checksum per entry, a damaged
\* replica refuses to vote, take appends or stand until a peer repairs it.
\* Each tagged line is one rule for DEV-10: [g] a guard conjunct, [u v] an
\* update of v. tools/mutants.py drops each, and flips each comparison.

\* The checksum: the damage is found, and the slot is marked bad.
ParDetect(i, k) ==
    /\ bad' = [bad EXCEPT ![i] = k]      \* [u bad]

\* A message reaches its server and is handled as Raft says, unless the
\* server is damaged: then it grants no vote and takes no append.
ZNormal(m) ==
    /\ m.mtype = RequestVoteRequest => bad[m.mdest] = 0      \* [g]
    /\ m.mtype = AppendEntriesRequest => bad[m.mdest] = 0      \* [g]
    /\ FeroReceive(m)

\* A damaged server drops a vote request or an append, unanswered.
ZIgnore(m) ==
    /\ bad[m.mdest] # 0      \* [g]
    /\ m.mtype \in {RequestVoteRequest, AppendEntriesRequest}
    /\ Discard(m)
    /\ UNCHANGED <<pendingMessages, serverVars, candidateVars, leaderVars, logVars, configVars, durableState>>

\* A damaged server does not stand.
ZTimeout(i) ==
    /\ bad[i] = 0      \* [g]
    /\ BTimeout(i)

\* Repair: i copies entry k from a peer that knows entry k is committed, so
\* the peer's copy is the committed one (Raft's state machine safety).
\* RepairFrom = "leader": only the current leader may be the peer.
ZRepair(i, j) ==
    /\ bad[i] # 0      \* [g]
    /\ j \in up \ {i}
    /\ RepairFrom = "leader" => state[j] = Leader
    /\ bad[j] = 0      \* [g]
    /\ commitIndex[j] >= bad[i]      \* [g]
    /\ log' = [log EXCEPT ![i] = [@ EXCEPT ![bad[i]] = log[j][bad[i]]]]      \* [u log]
    /\ bad' = [bad EXCEPT ![i] = 0]      \* [u bad]
    /\ UNCHANGED <<messageVars, serverVars, candidateVars, leaderVars, commitIndex, configVars, durableState>>
\* MUTATE-END

----
\* The fault.

RestartKeep(i) ==
    /\ state'          = [state EXCEPT ![i] = Follower]
    /\ votesResponded' = [votesResponded EXCEPT ![i] = {}]
    /\ votesGranted'   = [votesGranted EXCEPT ![i] = {}]
    /\ matchIndex'     = [matchIndex EXCEPT ![i] = [j \in Server |-> 0]]
    /\ pendingConfChangeIndex' = [pendingConfChangeIndex EXCEPT ![i] = 0]
    /\ pendingMessages' = ClearPendingMessages(i)
    /\ currentTerm' = [currentTerm EXCEPT ![i] = durableState[i].currentTerm]
    /\ votedFor'    = [votedFor EXCEPT ![i] = durableState[i].votedFor]
    /\ config'      = [config EXCEPT ![i] = durableState[i].config]

DLog(i) == SubSeq(log[i], 1, durableState[i].log)

DamageRestart(i, k) ==
    /\ i \in up
    /\ faults < FaultLimit
    /\ Cardinality(damaged) < DamageLimit
    /\ ~ \E d \in damaged : d[1] = i
    /\ DistinctOffsets => ~ \E d \in damaged : d[2] = k
    /\ DamageLeaderOnly => state[i] = Leader
    /\ k \in 2..Min({durableState[i].commitIndex, durableState[i].log})
    /\ damaged' = damaged \cup {<<i, k>>}
    /\ faults' = faults + 1
    /\ CASE ZMode = "cut" ->
              /\ RestartKeep(i)
              /\ log' = [log EXCEPT ![i] = SubSeq(DLog(i), 1, k - 1)]
              /\ commitIndex' = [commitIndex EXCEPT ![i] = Min({durableState[i].commitIndex, k - 1})]
              /\ durableState' = [durableState EXCEPT ![i].log = k - 1,
                                                      ![i].commitIndex = Min({durableState[i].commitIndex, k - 1})]
              /\ UNCHANGED <<messages, reconfigCount, up, dead, bad>>
         [] ZMode = "silent" ->
              /\ RestartKeep(i)
              /\ log' = [log EXCEPT ![i] = [DLog(i) EXCEPT ![k] = [term |-> DLog(i)[k].term,
                                                                 type |-> DLog(i)[k].type,
                                                                 value |-> [val |-> 7]]]]
              /\ commitIndex' = [commitIndex EXCEPT ![i] = durableState[i].commitIndex]
              /\ UNCHANGED <<messages, reconfigCount, up, dead, bad, durableState>>
         [] ZMode \in {"rejoin", "ghost"} ->
              \* E-14's LoseDisk: wiped. "rejoin": gone for good under this id
              \* (a new id may be added by healing). "ghost": back at once
              \* under the same id, empty (E-14's GhostReturn).
              /\ DownReset(i)
              /\ currentTerm' = [currentTerm EXCEPT ![i] = 0]
              /\ commitIndex' = [commitIndex EXCEPT ![i] = 0]
              /\ votedFor'    = [votedFor EXCEPT ![i] = Nil]
              /\ log'         = [log EXCEPT ![i] = <<>>]
              /\ config'      = [config EXCEPT ![i] = NoConf]
              /\ durableState' = [durableState EXCEPT ![i] =
                      [currentTerm |-> 0, votedFor |-> Nil, log |-> 0, commitIndex |-> 0, config |-> NoConf]]
              /\ IF ZMode = "ghost"
                 THEN /\ up' = up \cup {i}
                      /\ UNCHANGED dead
                 ELSE /\ up' = up \ {i}
                      /\ dead' = dead \cup {i}
              /\ UNCHANGED <<reconfigCount, bad>>
         [] ZMode = "par" ->
              /\ RestartKeep(i)
              /\ log' = [log EXCEPT ![i] = [DLog(i) EXCEPT ![k] = BadEntry]]
              /\ commitIndex' = [commitIndex EXCEPT ![i] = durableState[i].commitIndex]
              /\ ParDetect(i, k)
              /\ UNCHANGED <<messages, reconfigCount, up, dead, durableState>>


----
\* The next-state relation: MCferolive's LiveNext0, with the timeout, the
\* message handler and the faults of this module. Every other disjunct is
\* E-14b's, copied.

ZOtherStep ==
    \/ \E i, j \in up : ~BatchVote /\ RequestVote(i, j)
    \/ \E i \in up : BatchVote /\ BroadcastVote(i)
    \/ \E i \in up : FeroBecomeLeader(i)
    \/ \E i \in up : BClientRequest(i)
    \/ \E i \in up : AdvanceCommitIndex(i)
    \/ \E i \in up : /\ CoarseAE => matchIndex[i][i] < Len(log[i])
                     /\ AppendEntriesToSelf(i)
    \/ \E i \in up : ZTimeout(i)
    \/ \E i \in up : ~EagerReady /\ Ready(i)
    \/ \E i \in up : ~EagerApply /\ FeroApplyConf(i)
    \/ \E i \in up, j \in Server : FeroConf(i, j)

ZServerStep ==
    \/ \E i, j \in up : \E b, e \in matchIndex[i][j]+1..Len(log[i])+1 :
            /\ CoarseAE => (b = matchIndex[i][j] + 1 /\ e = Len(log[i]) + 1)
            /\ CoarseAE => (matchIndex[i][j] < Len(log[i]) \/ sentCommit[i][j] # <<currentTerm[i], commitIndex[i]>>)
            /\ AppendEntries(i, j, <<b, e>>)
            /\ sentCommit' = [sentCommit EXCEPT ![i][j] = <<currentTerm[i], commitIndex[i]>>]
            /\ UNCHANGED bad
    \/ ZOtherStep /\ UNCHANGED <<sentCommit, bad>>
    \/ \E i \in up, j \in Server : ZRepair(i, j) /\ UNCHANGED sentCommit

ZDeliver ==
    \/ \E m \in DOMAIN messages : m.mdest \in up /\ ZNormal(m)
    \/ \E m \in DOMAIN messages : m.mdest \in up /\ FeroRefuseVote(m)
    \/ \E m \in DOMAIN messages : m.mdest \in up /\ ZIgnore(m)

ZDeliverStep == ZDeliver /\ UNCHANGED <<up, dead, faults, sentCommit, bad, damaged>>

ZReadyStep == ReadyStep /\ UNCHANGED <<bad, damaged>>

\* NoCrash: the damage restarts are the only faults (the two-damage runs).
ZFault ==
    \/ ~NoCrash /\ Fault /\ UNCHANGED <<sentCommit, bad, damaged>>
    \/ \E i \in Server, k \in 1..10 : DamageRestart(i, k) /\ UNCHANGED sentCommit

ZNext0 ==
    IF EagerReady /\ AnyDirty
    THEN ZReadyStep
    ELSE IF EagerNet /\ Deliverable
    THEN ZDeliverStep
    ELSE \/ ZServerStep /\ UNCHANGED <<up, dead, faults, damaged>>
         \/ ~EagerNet /\ ZDeliverStep
         \/ ZFault
         \/ \E i \in Server : Recover(i) /\ UNCHANGED <<sentCommit, bad, damaged>>

----
\* The ghost: the longest committed log, from servers with no bad slot.

CleanCommitted == {SubSeq(log[i], 1, Min({commitIndex[i], Len(log[i])})) : i \in {s \in Server : bad[s] = 0}}

GhostStep ==
    LET cs  == CleanCommitted'
        ext == {c \in cs : IsPrefix(ghost, c)}
    IN  ghost' = IF ext = {} THEN ghost
                 ELSE CHOOSE c \in ext : \A d \in ext : Len(d) <= Len(c)

ZNext == ZNext0 /\ GhostStep
         /\ goalv' = (Goal)' /\ livev' = (LiveMajority)' /\ planv' = (PlanDone)'

ZInit == LiveInit
         /\ bad = [i \in Server |-> 0]
         /\ damaged = {}
         /\ ghost = CHOOSE c \in {SubSeq(log[i], 1, commitIndex[i]) : i \in Server} :
                        \A i \in Server : Len(SubSeq(log[i], 1, commitIndex[i])) <= Len(c)

ZSpec == ZInit /\ [][ZNext]_<<allvars, planv, zvars>>

----
\* Properties. The shipped 8, through TrueLog, and NoLostCommit.

ZLogInv ==
    \A i, j \in Server :
        \/ IsPrefix(TCommitted(i), TCommitted(j))
        \/ IsPrefix(TCommitted(j), TCommitted(i))

ZLogMatchingInv ==
    \A i, j \in Server :
        \A n \in (1..Len(TrueLog(i))) \cap (1..Len(TrueLog(j))) :
            TrueLog(i)[n].term = TrueLog(j)[n].term =>
            SubSeq(TrueLog(i), 1, n) = SubSeq(TrueLog(j), 1, n)

ZQuorumLogInvLive ==
    \A i \in Server \ dead :
    \A S \in Quorum(GetConfig(i)) :
        (S \cap dead = {}) => \E j \in S : IsPrefix(TCommitted(i), TrueLog(j))

ZMoreUpToDateCorrectInv ==
    \A i, j \in Server :
       (\/ LastTerm(TrueLog(i)) > LastTerm(TrueLog(j))
        \/ /\ LastTerm(TrueLog(i)) = LastTerm(TrueLog(j))
           /\ Len(TrueLog(i)) >= Len(TrueLog(j))) =>
       IsPrefix(TCommitted(j), TrueLog(i))

ZLeaderCompletenessInv ==
    \A i \in Server :
        LET c == TCommitted(i) IN
        \A idx \in 1..Len(c) :
            \A l \in CurrentLeaders :
                currentTerm[l] > c[idx].term =>
                idx <= Len(TrueLog(l)) /\ TrueLog(l)[idx] = c[idx]

\* No committed entry is ever lost or changed: every server's committed
\* prefix agrees with the longest log ever committed, and every leader of a
\* term after an entry's term holds it.
NoLostCommit ==
    /\ \A i \in Server : IsPrefix(TCommitted(i), ghost) \/ IsPrefix(ghost, TCommitted(i))
    /\ \A l \in CurrentLeaders :
        \A n \in 1..Len(ghost) :
            currentTerm[l] > ghost[n].term => n <= Len(TrueLog(l)) /\ TrueLog(l)[n] = ghost[n]

\* EagerNet's own check (a message to an up server can always be delivered).
ZEagerNetOK == (EagerNet /\ ~AnyDirty /\ Deliverable) => ENABLED ZDeliverStep

\* The view: E-14b's LView plus this module's variables.
ZView == <<LView, planv, bad, ghost, damaged>>
=============================================================================
