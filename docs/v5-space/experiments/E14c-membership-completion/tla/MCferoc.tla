------------------------------ MODULE MCferoc ------------------------------
(***************************************************************************)
(* fero's E-14c model: E-14b's MCferolive.tla (which EXTENDS E-14's        *)
(* MCferoraft.tla, which EXTENDS etcd's etcdraft.tla), all unchanged, plus *)
(* the two invariants Raft really needs in place of two shipped ones that  *)
(* E-14b found too strong once servers hold different configurations.     *)
(* Written 2026-11-09.                                                     *)
(*                                                                         *)
(* Nothing in the steps changes. One history variable is added, ctl: for   *)
(* each log index that has ever been committed, the entry and the term in  *)
(* which it was FIRST committed (the term of the leader that committed it).*)
(* No step reads it. It is in the view, so TLC never merges two states     *)
(* whose histories differ, and every invariant that reads it is checked    *)
(* soundly.                                                                *)
(*                                                                         *)
(*  LeaderCompletenessInv (shipped) says: a leader whose term is above an  *)
(*    entry's OWN term holds every committed entry. Raft's property (the   *)
(*    Raft paper, Figure 3 and section 5.4.3) says: an entry committed IN  *)
(*    term T is in the log of every leader of a term above T. The two     *)
(*    differ for an entry of an old term that a later leader commits      *)
(*    (section 5.4.2): a leader of a term between the two (a candidate     *)
(*    that counts old votes late) may lack it, harmlessly. That is the     *)
(*    shape that stopped E-14b's three-disk and four-voters-append runs.  *)
(*    LeaderCompletenessRaftInv states Raft's property, with ctl's term.  *)
(*                                                                         *)
(*  QuorumLogInv (shipped; QuorumLogInvLive in E-14) says: every quorum    *)
(*    of EVERY server's applied configuration holds that server's         *)
(*    committed entries. A server two changes behind (a learner that has  *)
(*    not applied yet) fails it with a configuration it can never use.    *)
(*    What Raft needs from it comes in two parts. The first is the        *)
(*    election half of the safety argument                                 *)
(*    (Raft paper, section 5.4.3, steps 2 and 3): a server that lacks a   *)
(*    committed entry cannot collect a quorum of votes in the             *)
(*    configuration it would stand with. A voter refuses a candidate whose *)
(*    log is less up to date than its own (the shipped logOk), and a      *)
(*    member whose disk is lost never votes again. VoteQuorumInv says     *)
(*    exactly that, for every server that could stand: one that is a     *)
(*    voter of the latest committed configuration it knows (the campaign  *)
(*    guard makes it apply that configuration before standing).          *)
(*    The second is QuorumLogInv itself, but only for the LATEST committed *)
(*    configuration, the one every future leader stands in (or a later    *)
(*    one): each of its quorums whose disks all exist holds every         *)
(*    committed entry. Single-server changes keep this true from one      *)
(*    configuration to the next (Ongaro's thesis, section 4.2.1), so a    *)
(*    break means two changes overlapped. That is CommittedQuorumInv.      *)
(*                                                                         *)
(*  CommittedNeverLostInv (new, also from ctl): while a majority of the   *)
(*    latest committed configuration is up, an entry once committed stays *)
(*    at its index on some server whose disk still exists. The shipped    *)
(*    LogInv compares only the logs that exist now, so a commit that      *)
(*    every holder lost would go unseen by it. (When the only voter of a  *)
(*    one-voter configuration loses its disk, its data is gone whatever   *)
(*    the protocol does; the live-majority guard leaves that case out.)   *)
(***************************************************************************)
EXTENDS MCferolive

VARIABLE ctl

----
\* The committed indexes and the term of their first commit.

MaxCommit == MaxOrZero({commitIndex[i] : i \in Server})

\* After a step: index k is newly committed. In Raft only the leader that
\* commits it knows first, so the knower with the lowest term is that leader
\* (a deterministic choice also when a mutant lets several know at once).
Stamp(k) ==
    LET W == {i \in Server : commitIndex'[i] >= k}
        t == Min({currentTerm'[i] : i \in W})
        i == CHOOSE x \in W : currentTerm'[x] = t
    IN  [e |-> log'[i][k], t |-> t]

CtlNext ==
    ctl' = IF MaxCommit' > Len(ctl)
           THEN ctl \o [k \in 1..(MaxCommit' - Len(ctl)) |-> Stamp(Len(ctl) + k)]
           ELSE ctl

\* At the start every commit is the first leader's, each entry in its own term.
CtlInit ==
    ctl = [k \in 1..MaxCommit |->
              LET i == CHOOSE x \in Server : commitIndex[x] = MaxCommit
              IN  [e |-> log[i][k], t |-> log[i][k].term]]

CInit == LiveInit /\ CtlInit
CNext == LiveNext /\ CtlNext
CSpec == CInit /\ [][CNext]_<<allvars, planv, ctl>>

CView == <<LView, ctl>>

----
\* The replacement invariants.

Holds(j, k) == k <= Len(log[j]) /\ log[j][k] = ctl[k].e

\* Raft's Leader Completeness, with "committed in term T" read as Raft reads
\* it: the term of the leader that committed the entry.
LeaderCompletenessRaftInv ==
    \A l \in CurrentLeaders :
        \A k \in 1..Len(ctl) :
            ctl[k].t < currentTerm[l] => Holds(l, k)

\* The voters a server would stand with: on commit, those of the latest
\* committed configuration it knows; on append (the mutant), those of the
\* latest configuration in its log.
StandVoters(j) == IF OnAppend THEN AppendConf(j).jointConfig[1]
                  ELSE CommittedConf(j).jointConfig[1]

HoldsAllCommitted(j) == \A k \in 1..Len(ctl) : Holds(j, k)

\* k refuses j's vote request on log grounds: the shipped logOk, negated.
RefusesLog(k, j) ==
    \/ LastTerm(log[k]) > LastTerm(log[j])
    \/ /\ LastTerm(log[k]) = LastTerm(log[j])
       /\ Len(log[k]) > Len(log[j])

\* No server that lacks a committed entry, and could stand, can collect a
\* quorum of votes in the configuration it would stand with: every such
\* quorum has a member that refuses it, or whose disk is lost for good.
VoteQuorumInv ==
    \A j \in Server \ dead :
        (j \in StandVoters(j) /\ ~HoldsAllCommitted(j)) =>
            \A S \in Quorum(StandVoters(j)) :
                \E k \in S : k \in dead \/ RefusesLog(k, j)

\* The voters of the latest committed configuration (from ctl).
LatestCommittedVoters ==
    LET ks == {k \in 1..Len(ctl) : ctl[k].e.type = ConfigEntry}
    IN  IF ks = {} THEN {} ELSE ctl[Max(ks)].e.value.newconf

\* Every quorum of the latest committed configuration whose disks all exist
\* holds every committed entry (on at least one of its members).
CommittedQuorumInv ==
    \A S \in Quorum(LatestCommittedVoters) :
        (S \cap dead = {}) => \A k \in 1..Len(ctl) : \E j \in S : Holds(j, k)

\* No committed entry is lost while a majority of the latest committed
\* configuration is up.
CommittedNeverLostInv ==
    LiveMajority => \A k \in 1..Len(ctl) : \E i \in Server \ dead : Holds(i, k)

=============================================================================
