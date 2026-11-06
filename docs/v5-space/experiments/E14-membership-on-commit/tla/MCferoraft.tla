----------------------------- MODULE MCferoraft -----------------------------
(***************************************************************************)
(* fero's E-14 model: etcd's etcdraft.tla, unmodified, plus what fero      *)
(* needs checked. Written 2026-11-06.                                      *)
(*                                                                         *)
(* It EXTENDS the shipped spec, so every shipped action, message handler   *)
(* and invariant is used as is. It adds:                                   *)
(*  - FeroRules: the membership rules of etcd's raft code (raft.go), which *)
(*    the shipped spec leaves out or simplifies: a demotion (voter to      *)
(*    learner), a new leader's empty entry and pendingConfIndex, no        *)
(*    campaign with a committed config change not yet applied, and a       *)
(*    leader that steps down when its applied config removes it            *)
(*    (StepDownOnRemoval). With FeroRules = FALSE the shipped actions run. *)
(*  - Faults with a budget: a crash that keeps the disk (down until it     *)
(*    recovers), the shipped instant restart, a lost disk (the member never *)
(*    returns under its id; a spare id may join), message loss and         *)
(*    duplication. Recovery is free.                                       *)
(*  - OnAppend: the mutant where a config takes effect when appended      *)
(*    (the last config entry in a server's log), not when applied.         *)
(*  - Scenario inits: any initial voters and learners, and spare ids.      *)
(*  - Goal and LiveMajority, read by tools/agef.py on TLC's state graph:   *)
(*    from every reachable state with a live majority, a fault-free path   *)
(*    must reach a leader of its latest config that commits an entry of    *)
(*    its own term.                                                        *)
(*  - DEV-10: the membership rules between MUTATE-BEGIN and MUTATE-END    *)
(*    are tagged one per line; tools/mutants.py drops each guard and     *)
(*    update and flips each comparison. R6 = FALSE is a named ablation:  *)
(*    learners refuse votes.                                             *)
(***************************************************************************)
EXTENDS etcdraft

CONSTANTS ReconfigurationLimit, MaxTermLimit, RequestLimit, FaultLimit,
          InitVoters, InitLearners, Joiners,
          FeroRules, OnAppend, AllowDup, AllowLoseDisk, AllowRestart,
          AllowSnapshot, GhostReturn, CoarseAE, InitLeader, AllowDrop, AllowStepDown,
          LeaderLease, Plan, EagerApply, CrashLeaderOnly, InitR21,
          R6

VARIABLES up, dead, faults, goalv, livev, sentCommit

fvars == <<up, dead, faults, goalv, livev, sentCommit>>
allvars == <<vars, fvars>>

----
\* Configs

ConfAtEntry(e) == [jointConfig |-> <<e.value.newconf, {}>>, learners |-> e.value.learners]
NoConf == [jointConfig |-> <<{}, {}>>, learners |-> {}]
IsConf(e) == e.type = ConfigEntry
LastConfIdx(xlog, upto) == SelectLastInSubSeq(xlog, 1, upto, LAMBDA e : IsConf(e))

\* The config server i acts on.
\* On commit (etcd): the config var, set by applying committed entries.
\* On append (mutant): the last config entry anywhere in i's log.
AppendConf(i) == LET k == LastConfIdx(log[i], Len(log[i]))
                 IN  IF k = 0 THEN NoConf ELSE ConfAtEntry(log[i][k])
\* EagerApply (a reduction): a server acts on its latest committed config at
\* once, with no step between commit and apply (etcd applies in a later
\* step, which the default keeps).
CommittedConf0(i) == LET k == LastConfIdx(log[i], commitIndex[i])
                     IN  IF k = 0 THEN NoConf ELSE ConfAtEntry(log[i][k])
MCGetJointConfig(i) == IF OnAppend THEN AppendConf(i).jointConfig
                       ELSE IF EagerApply THEN CommittedConf0(i).jointConfig ELSE config[i].jointConfig
MCGetLearners(i)    == IF OnAppend THEN AppendConf(i).learners
                       ELSE IF EagerApply THEN CommittedConf0(i).learners ELSE config[i].learners

\* The latest committed config entry of i is applied.
CommittedConf(i) == LET k == LastConfIdx(log[i], commitIndex[i])
                    IN  IF k = 0 THEN NoConf ELSE ConfAtEntry(log[i][k])
ConfApplied(i) == EagerApply \/ config[i] = CommittedConf(i)

----
\* Initial state: one genesis config entry at term 1 on every initial member.

Members0 == InitVoters \cup InitLearners
Genesis == [term |-> 1, type |-> ConfigEntry,
            value |-> [newconf |-> InitVoters, learners |-> InitLearners]]

\* With InitLeader, the run starts once s1 leads in term 2 and its empty
\* entry is committed and known to all initial members (a reachable state:
\* the first election and its commit, done). Otherwise it starts at genesis.
L0 == CHOOSE i \in InitVoters : TRUE
\* V2: one fixed voter other than the first leader (healing plans name it).
V2 == CHOOSE v \in InitVoters \ {L0} : TRUE
Log0 == IF InitLeader
        THEN <<Genesis, [term |-> 2, type |-> ValueEntry, value |-> [val |-> 1]]>>
        ELSE <<Genesis>>
Term0 == IF InitLeader THEN 2 ELSE 1

\* InitR21 (scenario four-voters only): healing.py's finding R2-1, just
\* after the fault. Leader L0 appended "demote V2" in term 2, sent it to V2
\* alone, and went down for good. V2 holds the entry; the others do not.
\* Nothing is committed past the empty entry. (Reachable: the runs from
\* InitLeader reach it in 5 steps.)
DemoteV2 == [term |-> 2, type |-> ConfigEntry,
             value |-> [newconf |-> InitVoters \ {V2}, learners |-> InitLearners \cup {V2}]]
LogR21(i) == IF i \in {L0, V2} THEN Log0 \o <<DemoteV2>> ELSE Log0

FeroInit ==
    /\ messages = EmptyBag
    /\ pendingMessages = EmptyBag
    /\ currentTerm = [i \in Server |-> IF i \in Members0 THEN Term0 ELSE 0]
    /\ state = [i \in Server |-> IF InitLeader /\ i = L0 /\ ~InitR21 THEN Leader ELSE Follower]
    /\ votedFor = [i \in Server |-> IF InitLeader /\ i \in Members0 THEN L0 ELSE Nil]
    /\ votesResponded = [i \in Server |-> {}]
    /\ votesGranted = [i \in Server |-> {}]
    /\ matchIndex = [i \in Server |-> [j \in Server |->
            IF InitLeader /\ i = L0 /\ j \in Members0 THEN Len(Log0) ELSE 0]]
    /\ pendingConfChangeIndex = [i \in Server |-> IF InitLeader /\ i = L0 /\ FeroRules THEN 1 ELSE 0]
    /\ log = [i \in Server |-> IF i \in Members0 THEN (IF InitR21 THEN LogR21(i) ELSE Log0) ELSE <<>>]
    /\ commitIndex = [i \in Server |-> IF i \in Members0 THEN Len(Log0) ELSE 0]
    /\ config = [i \in Server |-> IF i \in Members0 THEN ConfAtEntry(Genesis) ELSE NoConf]
    /\ reconfigCount = 0
    /\ durableState = [i \in Server |->
            [currentTerm |-> IF i \in Members0 THEN Term0 ELSE 0,
             votedFor |-> IF InitLeader /\ i \in Members0 THEN L0 ELSE Nil,
             log |-> IF i \in Members0 THEN (IF InitR21 THEN Len(LogR21(i)) ELSE Len(Log0)) ELSE 0,
             commitIndex |-> IF i \in Members0 THEN Len(Log0) ELSE 0,
             config |-> IF i \in Members0 THEN ConfAtEntry(Genesis) ELSE NoConf]]
    /\ up = IF InitR21 THEN Server \ {L0} ELSE Server
    /\ dead = IF InitR21 THEN {L0} ELSE {}
    /\ faults = 0
    /\ goalv = (InitLeader /\ ~InitR21)
    /\ livev = TRUE
    /\ sentCommit = [i \in Server |-> [j \in Server |-> <<0, 0>>]]

----
\* Network: a message to a server that is down is lost when sent (MCSend
\* keeps the shipped one-AppendEntries-per-pair limit).

FeroSend(msg) ==
    IF msg.mdest \notin up
    THEN UNCHANGED pendingMessages
    ELSE
    /\ ~ \E n \in DOMAIN messages \union DOMAIN pendingMessages:
        /\ n.mdest = msg.mdest
        /\ n.msource = msg.msource
        /\ n.mterm = msg.mterm
        /\ n.mtype = AppendEntriesRequest
        /\ msg.mtype = AppendEntriesRequest
    /\ ~ \E n \in DOMAIN messages \union DOMAIN pendingMessages:
        /\ n.mdest = msg.msource
        /\ n.msource = msg.mdest
        /\ n.mterm = msg.mterm
        /\ n.mtype = AppendEntriesResponse
        /\ msg.mtype = AppendEntriesRequest
    \* A copy already in flight: sending it again is the network's
    \* duplication, which DupF models as a fault.
    /\ msg \notin DOMAIN messages \union DOMAIN pendingMessages
    /\ SendDirect(msg)

\* A reply identical to one already in flight is not added again (the
\* shipped Reply would raise its count, so a candidate resending a vote
\* request could pile up copies of the same answer without bound).
\* Duplication is a fault of its own (DupF).
FeroReply(response, request) ==
    /\ pendingMessages' = IF response \in DOMAIN pendingMessages \cup DOMAIN messages
                          THEN pendingMessages
                          ELSE WithMessage(response, pendingMessages)
    /\ messages' = WithoutMessage(request, messages)

----
\* Membership, as etcd's raft code does it (FeroRules = TRUE).

Noop == [val |-> 1]
ClientCount(xlog) == FoldSeq(LAMBDA e, c : IF e.type = ValueEntry /\ DOMAIN e.value = {"val"} /\ e.value.val = 0 THEN c + 1 ELSE c, 0, xlog)

\* MUTATE-BEGIN. The membership rules fero takes from etcd's raft code.
\* Each tagged line is one rule for DEV-10: [g] a guard conjunct, [u v] an
\* update of v. tools/mutants.py drops each, and flips each comparison.

\* raft.go becomeLeader: pendingConfIndex = lastIndex, then an empty entry.
\* raft.go tallies only its config's voters (the shipped spec needs
\* votesGranted itself to be a quorum, so a learner's vote blocks a win).
FeroBecomeLeader(i) ==
    /\ state[i] = Candidate
    /\ votesGranted[i] \cap GetConfig(i) \in Quorum(GetConfig(i))      \* [g]
    /\ state' = [state EXCEPT ![i] = Leader]
    /\ matchIndex' = [matchIndex EXCEPT ![i] = [j \in Server |-> IF j = i THEN Len(log[i]) ELSE 0]]
    /\ pendingConfChangeIndex' = [pendingConfChangeIndex EXCEPT ![i] = Len(log[i])]      \* [u pendingConfChangeIndex]
    /\ log' = [log EXCEPT ![i] = Append(@, [term |-> currentTerm[i], type |-> ValueEntry, value |-> Noop])]      \* [u log]
    /\ UNCHANGED <<messageVars, currentTerm, votedFor, candidateVars, commitIndex, configVars, durableState>>

\* raft.go stepLeader MsgProp: one conf change at a time, pendingConfIndex <= applied.
ProposeConf(i, newVoters, newLearners) ==
    /\ state[i] = Leader      \* [g]
    /\ reconfigCount < ReconfigurationLimit
    /\ pendingConfChangeIndex[i] <= commitIndex[i]      \* [g]
    /\ ConfApplied(i)      \* [g]
    /\ newVoters # {}      \* [g]
    /\ log' = [log EXCEPT ![i] = Append(@, [term |-> currentTerm[i], type |-> ConfigEntry, value |-> [newconf |-> newVoters, learners |-> newLearners]])]      \* [u log]
    /\ pendingConfChangeIndex' = [pendingConfChangeIndex EXCEPT ![i] = Len(log'[i])]      \* [u pendingConfChangeIndex]
    /\ reconfigCount' = reconfigCount + 1
    /\ UNCHANGED <<messageVars, serverVars, candidateVars, matchIndex, commitIndex, config, durableState>>

\* Which changes a scenario's healing makes (Plan): "all" lets the leader
\* make any change; the others are the healing steps of DESIGN-V5 4.2 for
\* that scenario. V2 is one fixed voter other than the first leader.
PlanOK(op, j) ==
    CASE Plan = "all"      -> TRUE
      [] Plan = "swap"     -> \/ op = "promote" /\ j \in InitLearners
                              \/ op \in {"demote", "remove"} /\ j = V2
      [] Plan = "demote"   -> op \in {"demote", "remove"} /\ j = V2
      [] Plan = "stepback" -> \/ op = "demote" /\ j = V2
                              \/ op = "promote" /\ j \in InitLearners
      [] Plan = "grow"     -> op = "promote" /\ j \in InitLearners
      [] Plan = "replace"  -> \/ op = "addvoter" /\ j \in Joiners
                              \/ op = "remove" /\ j \in InitVoters

AddLearnerF(i, j) == /\ PlanOK("addlearner", j)
                     /\ j \notin GetConfig(i) \cup GetLearners(i)      \* [g]
                     /\ ProposeConf(i, GetConfig(i), GetLearners(i) \cup {j})
AddVoterF(i, j)   == /\ PlanOK("addvoter", j)
                     /\ j \notin GetConfig(i) \cup GetLearners(i)      \* [g]
                     /\ ProposeConf(i, GetConfig(i) \cup {j}, GetLearners(i))
PromoteF(i, j)    == /\ PlanOK("promote", j)
                     /\ j \in GetLearners(i)      \* [g]
                     /\ ProposeConf(i, GetConfig(i) \cup {j}, GetLearners(i) \ {j})
DemoteF(i, j)     == /\ PlanOK("demote", j)
                     /\ j \in GetConfig(i)      \* [g]
                     /\ ProposeConf(i, GetConfig(i) \ {j}, GetLearners(i) \cup {j})
RemoveF(i, j)     == /\ PlanOK("remove", j)
                     /\ j \in GetConfig(i) \cup GetLearners(i)      \* [g]
                     /\ ProposeConf(i, GetConfig(i) \ {j}, GetLearners(i) \ {j})

\* Apply the latest committed config. A leader it removes steps down
\* (raft.go switchToConfig with StepDownOnRemoval).
FeroApplyConf(i) ==
    /\ LastConfIdx(log[i], commitIndex[i]) > 0      \* [g]
    /\ ~ConfApplied(i)      \* [g]
    /\ config' = [config EXCEPT ![i] = CommittedConf(i)]      \* [u config]
    /\ state' = [state EXCEPT ![i] = IF state[i] = Leader /\ i \notin CommittedConf(i).jointConfig[1] THEN Follower ELSE state[i]]      \* [u state]
    /\ UNCHANGED <<messageVars, currentTerm, votedFor, candidateVars, leaderVars, logVars, reconfigCount, durableState>>

\* raft.go hup: promotable (a voter of its applied config) and no committed
\* config change left to apply.
CanCampaign(i) ==
    /\ i \in GetConfig(i)      \* [g]
    /\ ConfApplied(i)      \* [g]

FeroTimeout(i) ==
    /\ state[i] \in {Follower, Candidate}
    /\ CanCampaign(i)
    /\ state' = [state EXCEPT ![i] = Candidate]
    /\ currentTerm' = [currentTerm EXCEPT ![i] = currentTerm[i] + 1]
    /\ votedFor' = [votedFor EXCEPT ![i] = i]
    /\ votesResponded' = [votesResponded EXCEPT ![i] = {}]
    /\ votesGranted' = [votesGranted EXCEPT ![i] = {}]
    /\ UNCHANGED <<messageVars, leaderVars, logVars, configVars, durableState>>
\* MUTATE-END

\* Learners vote (raft.go, "learners must be allowed to cast votes"): the
\* shipped handler grants by term, log and vote alone. R6 = FALSE: a server
\* that is not a voter of its own config refuses every vote.
FeroReceive(m) ==
    /\ R6 \/ m.mtype # RequestVoteRequest \/ m.mterm > currentTerm[m.mdest] \/ m.mdest \in GetConfig(m.mdest)
    /\ Receive(m)
FeroRefuseVote(m) ==
    LET i == m.mdest
        j == m.msource
    IN  /\ ~R6
        /\ m.mtype = RequestVoteRequest
        /\ m.mterm <= currentTerm[i]
        /\ i \notin GetConfig(i)
        /\ Reply([mtype |-> RequestVoteResponse, mterm |-> currentTerm[i],
                  mvoteGranted |-> FALSE, msource |-> i, mdest |-> j], m)
        /\ UNCHANGED <<serverVars, candidateVars, leaderVars, logVars, configVars, durableState>>

----
\* Faults (each counts against FaultLimit) and recovery (free).

DownReset(i) ==
    /\ state'          = [state EXCEPT ![i] = Follower]
    /\ votesResponded' = [votesResponded EXCEPT ![i] = {}]
    /\ votesGranted'   = [votesGranted EXCEPT ![i] = {}]
    /\ matchIndex'     = [matchIndex EXCEPT ![i] = [j \in Server |-> 0]]
    /\ pendingConfChangeIndex' = [pendingConfChangeIndex EXCEPT ![i] = 0]
    /\ pendingMessages' = ClearPendingMessages(i)
    /\ messages' = [m \in {n \in DOMAIN messages : n.mdest # i} |-> messages[m]]

\* A crash that keeps the disk: down, back to its durable state.
Crash(i) ==
    /\ i \in up
    /\ faults < FaultLimit
    /\ CrashLeaderOnly => state[i] = Leader
    /\ DownReset(i)
    /\ currentTerm' = [currentTerm EXCEPT ![i] = durableState[i].currentTerm]
    /\ commitIndex' = [commitIndex EXCEPT ![i] = durableState[i].commitIndex]
    /\ votedFor'    = [votedFor EXCEPT ![i] = durableState[i].votedFor]
    /\ log'         = [log EXCEPT ![i] = SubSeq(@, 1, durableState[i].log)]
    /\ config'      = [config EXCEPT ![i] = durableState[i].config]
    /\ up' = up \ {i}
    /\ faults' = faults + 1
    /\ UNCHANGED <<durableState, reconfigCount, dead>>

Recover(i) ==
    /\ i \notin up
    /\ i \notin dead
    /\ up' = up \cup {i}
    /\ UNCHANGED <<vars, dead, faults>>

\* A lost disk: the member never comes back under this id. Its state is
\* wiped (it no longer exists). A spare id in Joiners may be added instead.
\* GhostReturn (a mutant): it comes back at once under the same id, empty.
LoseDisk(i) ==
    /\ AllowLoseDisk
    /\ i \notin dead
    /\ faults < FaultLimit
    /\ DownReset(i)
    /\ currentTerm' = [currentTerm EXCEPT ![i] = 0]
    /\ commitIndex' = [commitIndex EXCEPT ![i] = 0]
    /\ votedFor'    = [votedFor EXCEPT ![i] = Nil]
    /\ log'         = [log EXCEPT ![i] = <<>>]
    /\ config'      = [config EXCEPT ![i] = NoConf]
    /\ durableState' = [durableState EXCEPT ![i] =
            [currentTerm |-> 0, votedFor |-> Nil, log |-> 0, commitIndex |-> 0, config |-> NoConf]]
    /\ IF GhostReturn
       THEN /\ up' = up \cup {i}
            /\ UNCHANGED dead
       ELSE /\ up' = up \ {i}
            /\ dead' = dead \cup {i}
    /\ faults' = faults + 1
    /\ UNCHANGED <<reconfigCount>>

\* The shipped instant restart, counted as a fault.
RestartF(i) ==
    /\ AllowRestart
    /\ i \in up
    /\ faults < FaultLimit
    /\ Restart(i)
    /\ faults' = faults + 1
    /\ UNCHANGED <<up, dead>>

\* A leader or candidate gives up with no message (in etcd: CheckQuorum, or
\* an election timeout as candidate). Shipped as a free step; a fault here.
StepDownF(i) ==
    /\ AllowStepDown
    /\ i \in up
    /\ faults < FaultLimit
    /\ StepDownToFollower(i)
    /\ faults' = faults + 1
    /\ UNCHANGED <<up, dead>>

DropF(m) ==
    /\ AllowDrop
    /\ faults < FaultLimit
    /\ m \in DOMAIN messages
    /\ messages[m] = 1
    /\ DropMessage(m)
    /\ faults' = faults + 1
    /\ UNCHANGED <<up, dead>>

DupF(m) ==
    /\ AllowDup
    /\ faults < FaultLimit
    /\ m \in DOMAIN messages
    /\ messages[m] = 1
    /\ DuplicateMessage(m)
    /\ faults' = faults + 1
    /\ UNCHANGED <<up, dead>>

----
\* Bounds (as MCetcdraft's): terms, client requests, one candidate at a time.

\* LeaderLease (a reduction, as PreVote with CheckQuorum gives): a follower
\* stands only when no server that is up leads in its term or a later one.
\* This model has no partitions, so an up leader is one its followers can
\* reach, given time; with PreVote and CheckQuorum they would not stand.
BTimeout(i) ==
    /\ i \in up
    /\ currentTerm[i] < MaxTermLimit
    /\ LeaderLease => ~\E l \in up : state[l] = Leader /\ currentTerm[l] >= currentTerm[i]
    /\ Cardinality({s \in GetConfig(i) : state[s] = Candidate}) < 1
    /\ IF FeroRules THEN FeroTimeout(i) ELSE Timeout(i)

BClientRequest(i) ==
    /\ i \in up
    /\ ClientCount(log[i]) < RequestLimit
    /\ ClientRequest(i, 0)

ShippedConf(i, j) ==
    /\ reconfigCount < ReconfigurationLimit
    /\ \/ AddNewServer(i, j)
       \/ AddLearner(i, j)
       \/ DeleteServer(i, j)

FeroConf(i, j) ==
    \/ AddLearnerF(i, j)
    \/ AddVoterF(i, j)
    \/ PromoteF(i, j)
    \/ DemoteF(i, j)
    \/ RemoveF(i, j)

----
\* The next-state relation. Every server action needs the server up.
\* Faults and Recover are named so tools/agef.py can leave them out.

OtherStep ==
    \/ \E i, j \in up : RequestVote(i, j)
    \/ \E i \in up : IF FeroRules THEN FeroBecomeLeader(i) ELSE BecomeLeader(i)
    \/ \E i \in up : BClientRequest(i)
    \/ \E i \in up : AdvanceCommitIndex(i)
    \/ \E i \in up : /\ CoarseAE => matchIndex[i][i] < Len(log[i])
                     /\ AppendEntriesToSelf(i)
    \/ \E i, j \in up : ~CoarseAE /\ Heartbeat(i, j)
    \/ \E i, j \in up : \E index \in 1..commitIndex[i] : AllowSnapshot /\ SendSnapshot(i, j, index)
    \/ \E i \in up : BTimeout(i)
    \/ \E i \in up : Ready(i)
    \/ \E i \in up : ~EagerApply /\ IF FeroRules THEN FeroApplyConf(i) ELSE ApplySimpleConfChange(i)
    \* With EagerApply, a leader its committed config removes steps down (the
    \* apply step's StepDownOnRemoval, on its own).
    \/ \E i \in up : /\ EagerApply /\ FeroRules /\ state[i] = Leader /\ i \notin GetConfig(i)
                     /\ state' = [state EXCEPT ![i] = Follower]
                     /\ UNCHANGED <<messageVars, currentTerm, votedFor, candidateVars, leaderVars, logVars, configVars, durableState>>
    \/ \E i \in up, j \in Server :
            IF FeroRules THEN FeroConf(i, j) ELSE (i \in up /\ ShippedConf(i, j))

ServerStep ==
    \/ \E i, j \in up : \E b, e \in matchIndex[i][j]+1..Len(log[i])+1 :
            /\ CoarseAE => (b = matchIndex[i][j] + 1 /\ e = Len(log[i]) + 1)
            \* CoarseAE: an append only when it carries news, entries the
            \* follower may lack or a commit index it was not sent (no idle
            \* heartbeats; LeaderLease stands in for their other job).
            /\ CoarseAE => (matchIndex[i][j] < Len(log[i]) \/ sentCommit[i][j] # <<currentTerm[i], commitIndex[i]>>)
            /\ AppendEntries(i, j, <<b, e>>)
            /\ sentCommit' = [sentCommit EXCEPT ![i][j] = <<currentTerm[i], commitIndex[i]>>]
    \/ OtherStep /\ UNCHANGED sentCommit

Deliver ==
    \/ \E m \in DOMAIN messages : m.mdest \in up /\ (IF FeroRules THEN FeroReceive(m) ELSE Receive(m))
    \/ \E m \in DOMAIN messages : m.mdest \in up /\ FeroRefuseVote(m)

Progress == \/ ServerStep /\ UNCHANGED <<up, dead, faults>>
            \/ Deliver /\ UNCHANGED <<up, dead, faults, sentCommit>>

Fault ==
    \/ \E i \in Server : Crash(i)
    \/ \E i \in Server : LoseDisk(i)
    \/ \E i \in Server : RestartF(i)
    \/ \E i \in Server : StepDownF(i)
    \/ \E m \in DOMAIN messages : DropF(m)
    \/ \E m \in DOMAIN messages : DupF(m)

FeroNext0 ==
    \/ Progress
    \/ Fault /\ UNCHANGED sentCommit
    \/ \E i \in Server : Recover(i) /\ UNCHANGED sentCommit


----
\* Properties.

\* The voters of the latest committed config any non-dead server knows.
KnownCommittedConfVoters ==
    LET live == Server \ dead
        best == CHOOSE i \in live : \A j \in live : commitIndex[j] <= commitIndex[i]
    IN  CommittedConf(best).jointConfig[1]

\* A majority of those voters is up.
LiveMajority ==
    LET V == KnownCommittedConfVoters
    IN  V # {} /\ Cardinality(V \cap up) * 2 > Cardinality(V)

\* A leader of its latest config has committed an entry of its own term.
Goal ==
    \E l \in up :
        /\ state[l] = Leader
        /\ l \in GetConfig(l)
        /\ ConfApplied(l) \/ OnAppend
        /\ commitIndex[l] > 0
        /\ log[l][commitIndex[l]].term = currentTerm[l]

\* Shipped QuorumLogInv, but a quorum must hold a committed entry only
\* among members whose disks still exist (a lost disk is not a holder, and
\* cannot vote either, since it never returns under its id).
QuorumLogInvLive ==
    \A i \in Server \ dead :
    \A S \in Quorum(GetConfig(i)) :
        (S \cap dead = {}) => \E j \in S : IsPrefix(Committed(i), log[j])

\* As an invariant, NotGoal asks TLC for the shortest path to the goal (a
\* violation is a witness that the goal is reachable); a full run with no
\* violation shows the goal is unreachable within the bounds.
NotGoal == ~Goal

\* The view the agef tool reads: two booleans per state.
GoalFlag == Goal
LiveFlag == LiveMajority

----
\* The step relation: the flags follow every step.
FeroNext == FeroNext0 /\ goalv' = (Goal)' /\ livev' = (LiveMajority)'

FeroSpec == FeroInit /\ [][FeroNext]_allvars

\* The view TLC tells states apart by: every variable, except that a response
\* older than its receiver's term is left out of the network. Such a
\* response can only ever be dropped as stale (DropStaleResponse), since
\* terms only grow, so two states that differ only in those are bisimilar.
IsStaleResp(n) == n.mtype \in {RequestVoteResponse, AppendEntriesResponse}
                  /\ n.mterm < currentTerm[n.mdest]
LiveBag(b) == [n \in {x \in DOMAIN b : ~IsStaleResp(x)} |-> b[n]]
FeroView == <<LiveBag(messages), LiveBag(pendingMessages), serverVars, candidateVars,
              leaderVars, logVars, configVars, durableState, fvars>>

\* Members in the same role at the start are interchangeable.
Perms(S) == IF Cardinality(S) > 1 THEN Permutations(S) ELSE {}
SymVoters == (IF InitLeader THEN InitVoters \ {L0} ELSE InitVoters)
             \ (IF Plan \in {"swap", "demote", "stepback"} THEN {V2} ELSE {})
Symmetry == Perms(SymVoters) \cup Perms(InitLearners) \cup Perms(Joiners)
=============================================================================
