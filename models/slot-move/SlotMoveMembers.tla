-------------------------- MODULE SlotMoveMembers --------------------------
(* The one-commit slot move, third model: one group with its members.

   SlotMove.tla takes a group as one log: a leader change may drop a tail,
   and two faults are "no majority".  This model opens one of the two data
   groups up.  The group named by Real has members.  Each member has its
   own log, its own term and its own commit index.  Members fail and come
   back.  Leaders are elected by votes, with Raft's log check.  A
   membership change is an entry; a member uses the newest configuration in
   the part of its log it knows to be committed.  The other data group
   stays one log, as in SlotMove.tla.  The slot table is left out: one move,
   from A to B, is under way from the start.

   The question (the record's K-01): does the move still hold when it meets
   a membership change and two member faults, with an election that meets a
   voter behind the log, an old leader that still acts, and a new leader
   that does not yet know what is committed?

   The Raft steps are short forms.  An election is one step: a quorum of
   the candidate's configuration grants at once.  A leader hands a member
   its whole log in one step.  They are marked @keeps with the ledger's
   Raft records; the Raft port has its own proof (probe P1).

   Marks:  \* @rule <id>  a move's rule;  \* @keeps <id>  a rule the move
   leans on;  \* @world  an assumption.

   The decided form (the owner's answers to card 0002): the bounds named
   mem-d-* set OneCommit = TRUE, as in SlotMove.tla.  This model has no
   slot table, so the switch BackFirst is not here. *)
EXTENDS Naturals, Sequences, FiniteSets, TLC

CONSTANTS M,          \* the members that may hold a copy of the real group
          V0,         \* its first voters
          Real,       \* which data group has members: "A" (the source) or "B"
          S, N,       \* the streams, and the writes each makes
          MaxTerm,    \* elections, counted by the highest term
          MaxFaults,  \* member faults
          MaxCfg,     \* membership changes proposed
          MaxPCrash   \* leader changes in the other group

(* A switch with a default, as in SlotMove.tla.  FALSE: a leader takes a
   write only for a slot the log it knows committed holds open.  TRUE (the
   decided form): the guard reads its own log end alone. *)
OneCommit == FALSE

VARIABLES mlog, term, mci, lead, alive,   \* the real group, by member
          plog, pci,                      \* the other group: one log, one commit index
          faults, cfgs, pcrashes,
          met     \* (for the reach check) an election met a voter behind the log

vars == <<mlog, term, mci, lead, alive, plog, pci, faults, cfgs, pcrashes, met>>

DG == {"A", "B"}
Copies == 3
Sym == Permutations(V0)      \* the first voters are alike
Max(X) == CHOOSE x \in X : \A y \in X : y <= x
PosLess(p, q) == p[1] < q[1] \/ (p[1] = q[1] /\ p[2] < q[2])
IsPrefix(a, b) == Len(a) <= Len(b) /\ SubSeq(b, 1, Len(a)) = a
Idx(L, T)    == {i \in DOMAIN L : L[i].t \in T}
LastOf(L, T) == IF Idx(L, T) = {} THEN 0 ELSE Max(Idx(L, T))
HasT(L, t)   == \E i \in DOMAIN L : L[i].t = t
IsW(e) == e.t = "w"

(* ---- what a log says about the slot (as in SlotMove.tla) ---- *)
Stops == {"fence", "unf", "final"}
Mode(g, L) ==
    LET k == LastOf(L, Stops) IN
    IF k = 0 THEN (IF g = "A" THEN "open" ELSE "none")
    ELSE IF L[k].t = "fence" THEN "fenced"                      \* @rule slot-move.3
    ELSE "open"                                                 \* @rule slot-move.7
NoTab == [seq |-> 0, hi |-> [s \in S |-> 0]]
BaseIx(L) == LastOf(L, {"final"})
BaseTab(L) == IF BaseIx(L) = 0 THEN NoTab ELSE L[BaseIx(L)].tab          \* @rule stream-numbers.11
WsOf(L) == {i \in DOMAIN L : i > BaseIx(L) /\ L[i].t = "w"}
Tab(L) == LET B == BaseTab(L)
              W == WsOf(L)
          IN [seq |-> B.seq + Cardinality(W),
              hi  |-> [s \in S |-> Max({B.hi[s]} \cup {L[i].n : i \in {j \in W : L[j].s = s}})]]
OwnWs(L) == SelectSeq(SubSeq(L, BaseIx(L) + 1, Len(L)), IsW)
Vis(L)   == IF BaseIx(L) = 0 THEN OwnWs(L) ELSE L[BaseIx(L)].recs \o OwnWs(L)

(* ---- the real group's members ---- *)
Pre(i) == SubSeq(mlog[i], 1, mci[i])       \* what member i knows to be committed
CfgOf(L) == LET k == LastOf(L, {"cfg"}) IN IF k = 0 THEN V0 ELSE L[k].vs
Cfg(i) == CfgOf(Pre(i))                                         \* @keeps raft-config.13
Quorum(Q, V) == 2 * Cardinality(Q \cap V) > Cardinality(V)
LastTerm(L) == IF L = <<>> THEN 0 ELSE L[Len(L)].tm
UpToDate(i, j) == \/ LastTerm(mlog[i]) > LastTerm(mlog[j])
                  \/ LastTerm(mlog[i]) = LastTerm(mlog[j]) /\ Len(mlog[i]) >= Len(mlog[j])
Behind(j) == \E k \in M : Len(mlog[j]) < mci[k]

Init == /\ mlog = [i \in M |-> <<>>] /\ term = [i \in M |-> 0] /\ mci = [i \in M |-> 0]
        /\ lead = [i \in M |-> FALSE] /\ alive = [i \in M |-> TRUE]
        /\ plog = <<>> /\ pci = 0
        /\ faults = 0 /\ cfgs = 0 /\ pcrashes = 0 /\ met = FALSE

(* An election, in one step. *)
Elect(i) ==
    /\ alive[i] /\ ~lead[i] /\ term[i] < MaxTerm
    /\ i \in Cfg(i)                                             \* @keeps raft-config.12
    /\ \E Q \in SUBSET {j \in M : alive[j]} :
         /\ i \in Q
         /\ Quorum(Q, Cfg(i))                                   \* @keeps raft-config.1
         /\ \A j \in Q : term[j] <= term[i]                     \* @keeps raft-term-vote term
         /\ \A j \in Q : UpToDate(i, j)                         \* @keeps raft-term-vote log
         /\ term' = [j \in M |-> IF j \in Q THEN term[i] + 1 ELSE term[j]]
         /\ lead' = [j \in M |-> IF j = i THEN TRUE ELSE IF j \in Q THEN FALSE ELSE lead[j]]
    /\ mlog' = [mlog EXCEPT ![i] = Append(@, [t |-> "nop", tm |-> term[i] + 1])]   \* @keeps raft-config.3
    /\ met' = (met \/ \E j \in Cfg(i) \ {i} : alive[j] /\ Behind(j))
    /\ UNCHANGED <<mci, alive, plog, pci, faults, cfgs, pcrashes>>

(* A leader hands a member its log and what it knows to be committed. *)
Sync(l, j) ==
    /\ lead[l] /\ alive[l] /\ alive[j] /\ j # l
    /\ term[j] <= term[l]                                       \* @keeps raft-log term
    /\ mlog[j] # mlog[l] \/ term[j] < term[l] \/ mci[j] < mci[l]
    /\ mlog' = [mlog EXCEPT ![j] = mlog[l]]
    /\ term' = [term EXCEPT ![j] = term[l]]
    /\ lead' = [lead EXCEPT ![j] = FALSE]
    /\ mci'  = [mci EXCEPT ![j] = Max({mci[j], mci[l]})]
    /\ UNCHANGED <<alive, plog, pci, faults, cfgs, pcrashes, met>>

(* A leader learns that more of its log is committed. *)
Advance(l) ==
    /\ lead[l] /\ alive[l]
    /\ \E k \in (mci[l] + 1)..Len(mlog[l]) :
         /\ mlog[l][k].tm = term[l]                             \* @keeps raft-commit term
         /\ Quorum({j \in M : /\ term[j] = term[l] /\ Len(mlog[j]) >= k
                              /\ SubSeq(mlog[j], 1, k) = SubSeq(mlog[l], 1, k)},
                   Cfg(l))                                      \* @keeps raft-commit quorum
         /\ mci' = [mci EXCEPT ![l] = k]
         /\ lead' = [lead EXCEPT ![l] = l \in CfgOf(SubSeq(mlog[l], 1, k))]   \* @keeps raft-config.10
    /\ UNCHANGED <<mlog, term, alive, plog, pci, faults, cfgs, pcrashes, met>>

(* A membership change: one voter more or one voter less. *)
Reconf(l) ==
    /\ lead[l] /\ alive[l] /\ cfgs < MaxCfg
    /\ LastOf(mlog[l], {"cfg"}) <= mci[l]                       \* @keeps raft-config.5
    /\ mci[l] > 0 /\ mlog[l][mci[l]].tm = term[l]               \* @keeps raft-config.2
    /\ \E j \in M :
         LET vs == IF j \in Cfg(l) THEN Cfg(l) \ {j} ELSE Cfg(l) \cup {j} IN
         /\ vs # {}
         /\ j \notin Cfg(l) => IsPrefix(Pre(l), mlog[j])        \* @keeps learners.3
         /\ mlog' = [mlog EXCEPT ![l] = Append(@, [t |-> "cfg", vs |-> vs, tm |-> term[l]])]
    /\ cfgs' = cfgs + 1
    /\ UNCHANGED <<term, mci, lead, alive, plog, pci, faults, pcrashes, met>>

(* A member fails; it keeps its disk.  It comes back as a follower. *)
Kill(i) ==
    /\ alive[i] /\ faults < MaxFaults
    /\ alive' = [alive EXCEPT ![i] = FALSE] /\ lead' = [lead EXCEPT ![i] = FALSE]
    /\ faults' = faults + 1
    /\ UNCHANGED <<mlog, term, mci, plog, pci, cfgs, pcrashes, met>>
Rise(i) ==
    /\ ~alive[i]
    /\ alive' = [alive EXCEPT ![i] = TRUE]
    /\ UNCHANGED <<mlog, term, mci, lead, plog, pci, faults, cfgs, pcrashes, met>>

(* ---- the other group: one log ---- *)
PCommit == /\ pci < Len(plog) /\ pci' = pci + 1
           /\ UNCHANGED <<mlog, term, mci, lead, alive, plog, faults, cfgs, pcrashes, met>>
PCrash  == /\ pcrashes < MaxPCrash /\ pci < Len(plog)
           /\ \E k \in pci..(Len(plog) - 1) : plog' = SubSeq(plog, 1, k)
           /\ pcrashes' = pcrashes + 1
           /\ UNCHANGED <<mlog, term, mci, lead, alive, pci, faults, cfgs, met>>

(* ---- who acts for a group, and what it sees ---- *)
Some == CHOOSE i \in M : TRUE
Actors(g)  == IF g = Real THEN {i \in M : lead[i] /\ alive[i]} ELSE {Some}
Tellers(g) == IF g = Real THEN M ELSE {Some}       \* whose report of a commit may arrive
End(g, a)  == IF g = Real THEN mlog[a] ELSE plog  \* the actor's log, tail included
Com(g, a)  == IF g = Real THEN Pre(a) ELSE SubSeq(plog, 1, pci)
PutE(g, a, e) ==
    /\ IF g = Real THEN /\ mlog' = [mlog EXCEPT ![a] = Append(@, [e EXCEPT !.tm = term[a]])]
                        /\ UNCHANGED plog
       ELSE /\ plog' = Append(plog, e) /\ UNCHANGED mlog
    /\ UNCHANGED <<term, mci, lead, alive, pci, faults, cfgs, pcrashes, met>>

(* ---- the move ---- *)
Take(g, a, s) ==
    /\ Mode(g, Com(g, a)) = "open" \/ OneCommit                 \* @rule two-commit
    /\ Mode(g, End(g, a)) = "open"                              \* @rule slot-table.1 slot-move.1
    /\ LET T == Tab(End(g, a))
           n == T.hi[s] + 1                                     \* @keeps stream-numbers.4
       IN /\ n <= N
          /\ PutE(g, a, [t |-> "w", tm |-> 0, s |-> s, n |-> n, pos |-> <<1, T.seq + 1>>])

Fence(a) ==
    /\ Mode("A", Com("A", a)) = "open"                          \* @rule slot-move.2
    /\ Mode("A", End("A", a)) = "open"                          \* @rule slot-move.1 once
    /\ ~HasT(End("A", a), "fence")                              \* @rule slot-move.24 fence.once
    /\ PutE("A", a, [t |-> "fence", tm |-> 0])

Final(b) ==
    LET L == End("B", b) IN
    /\ \E t \in Tellers("A") :
         LET C == Com("A", t) IN                                \* @rule slot-move.4
         \E i \in DOMAIN C :
           /\ C[i].t = "fence"
           /\ ~HasT(L, "abort")                                 \* @rule slot-move.18
           /\ ~HasT(L, "final")                                 \* @rule slot-move.8
           /\ Real = "B" => Cardinality(CfgOf(L)) >= Copies     \* @rule slot-move.22
           /\ PutE("B", b, [t |-> "final", tm |-> 0,
                            recs |-> Vis(SubSeq(C, 1, i - 1)),
                            tab  |-> Tab(SubSeq(C, 1, i - 1))])

Abort(b) ==
    /\ ~HasT(End("B", b), "final")                              \* @rule slot-move.17
    /\ ~HasT(End("B", b), "abort")
    /\ PutE("B", b, [t |-> "abort", tm |-> 0])

Unfence(a) ==
    LET L == End("A", a)
        k == LastOf(L, Stops)
    IN
    /\ k > 0 /\ L[k].t = "fence"
    /\ k <= Len(Com("A", a))                                    \* @rule slot-move.19 fenced
    /\ \E t \in Tellers("B") : HasT(Com("B", t), "abort")       \* @rule slot-move.19
    /\ PutE("A", a, [t |-> "unf", tm |-> 0])

Next == \/ \E i \in M : Elect(i) \/ Advance(i) \/ Reconf(i) \/ Kill(i) \/ Rise(i)
        \/ \E l, j \in M : Sync(l, j)
        \/ PCommit \/ PCrash
        \/ \E g \in DG : \E a \in Actors(g) : \E s \in S : Take(g, a, s)
        \/ \E a \in Actors("A") : Fence(a) \/ Unfence(a)
        \/ \E b \in Actors("B") : Final(b) \/ Abort(b)

Spec == Init /\ [][Next]_vars

(* ================= the properties ================= *)
\* What the members know to be committed never disagrees.
RaftSafe == \A i, j \in M : IsPrefix(Pre(i), Pre(j)) \/ IsPrefix(Pre(j), Pre(i))

\* The real group's committed log: the longest part any member knows.
TruePre == Pre(CHOOSE i \in M : \A j \in M : mci[j] <= mci[i])
CLof(g) == IF g = Real THEN TruePre ELSE SubSeq(plog, 1, pci)

CWI    == UNION {{<<g, i>> : i \in Idx(CLof(g), {"w"})} : g \in DG}
Rec(o) == CLof(o[1])[o[2]]
K      == Cardinality(CWI)
Server == {g \in DG : Mode(g, CLof(g)) = "open"}

PosUnique == /\ \A o, q \in CWI : o # q => Rec(o).pos # Rec(q).pos
             /\ {Rec(o).pos : o \in CWI} = {<<1, i>> : i \in 1..K}
Once == \A o, q \in CWI : o # q => ~(Rec(o).s = Rec(q).s /\ Rec(o).n = Rec(q).n)
InOrder == \A o \in CWI :
             Rec(o).n = 1 + Cardinality({q \in CWI : /\ Rec(q).s = Rec(o).s
                                                     /\ PosLess(Rec(q).pos, Rec(o).pos)})
OneServer == Cardinality(Server) <= 1

\* What a record looks like, whichever group and term logged it.
Plain(e) == <<e.s, e.n, e.pos>>
Flat(V)  == [i \in DOMAIN V |-> Plain(V[i])]
Canon == [i \in 1..K |-> Plain(Rec(CHOOSE o \in CWI : Rec(o).pos = <<1, i>>))]
Views == PosUnique =>
           \A g \in DG : /\ IsPrefix(Flat(Vis(CLof(g))), Canon)
                         /\ g \in Server => Flat(Vis(CLof(g))) = Canon

\* A committed final copy holds the source's whole committed state at its fence.
Whole == LET L == CLof("B")
             A == CLof("A")
         IN \A i \in DOMAIN L :
              L[i].t = "final" =>
                \E j \in DOMAIN A : /\ A[j].t = "fence"
                                    /\ L[i].recs = Vis(SubSeq(A, 1, j - 1))
                                    /\ L[i].tab  = Tab(SubSeq(A, 1, j - 1))

\* No slot opens in a group that has fewer voters than the copies setting.
OpenFull == Real = "B" =>
              LET L == TruePre IN
              \A i \in DOMAIN L :
                L[i].t = "final" => Cardinality(CfgOf(SubSeq(L, 1, i - 1))) >= Copies

(* ---- the reach check: it must FAIL ---- *)
AllIn == K = N * Cardinality(S)
Moved == LET L == CLof("B") IN
         \E i, j \in DOMAIN L : i < j /\ L[i].t = "final" /\ L[j].t = "w"
\* the move completes, with two member faults, a committed membership
\* change, a second election, and an election that met a voter behind the log
NotDone == ~(/\ Moved /\ AllIn /\ faults = 2 /\ met
             /\ HasT(TruePre, "cfg")
             /\ \E i \in M : term[i] >= 2)
\* the same without the membership change (for small bounds)
NotMoved == ~(Moved /\ AllIn)
\* the move is given up, the source reopens and takes a write
NotBack == ~(LET L == CLof("A") IN
              \E i, j \in DOMAIN L : i < j /\ L[i].t = "unf" /\ L[j].t = "w")
=============================================================================
