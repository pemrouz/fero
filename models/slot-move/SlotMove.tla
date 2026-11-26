---------------------------- MODULE SlotMove ----------------------------
(* The one-commit slot move, in its full form (READY M6; GROUPS 4.3 rows 6
   and 8; LAYERS 2.6).

   A slot is a fixed share of a resource's keys.  A group is one Raft group.
   A move hands the slot from the group that serves it (the source) to
   another (the target).  The home group keeps the slot table: one row per
   slot that names the slot's group.

   The move, as this model reads the ledger:
     1. the target writes the slot's row into the home log.  The row's
        number is the move's name;
     2. the target may copy the slot's records early, unseen by reads, while
        the source still takes writes (the bulk copy);
     3. the source logs ONE entry, the fence.  It is the decision.  From
        then on the source takes no write to the slot;
     4. once the fence has committed, the target logs ONE entry, the final
        copy: the records it does not hold yet and the carried set.  When
        that entry commits the target serves the slot;
     5. to give up, the target logs an abort, writes the row back, and the
        source reopens by an entry of its own.

   The world (not counted as rules):
     - three abstract Raft groups: A and B hold data, H is the home group.
       A group is a log and a commit index.  A leader change may drop any
       part of the uncommitted tail; a dropped tail may come back until the
       next commit.  A group may lose its majority (two faults among three
       voters): it then takes nothing and commits nothing until it returns;
     - there are no stored messages.  Every report of the move is a fact in
       some group's committed log, and committed facts stay true here.  So
       a step that needs a report reads the sender's committed log.  A lost
       report is a step that is never taken; a late one is a step taken
       later; a report that arrives twice is a step that may run twice.  The
       table may be read stale: any earlier committed state of it;
     - writers: each stream (one writer's writes to the slot) numbers its
       writes 1, 2, 3...  Copies of every write are always in flight: any
       write may reach any group at any time, any number of times;
     - a membership change is an entry in the group's own log, between the
       move's entries; it sets the number of voters.

   Lines marked  \* @rule <id>   hold a rule of the ledger (or a named line).
   Lines marked  \* @keeps <id>  hold a rule from another mechanism that the
   move leans on.  Lines marked  \* @world <name>  are assumptions of the
   world.  mutants.txt plants one-line mistakes on them. *)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS S,          \* the streams: a subset of {"x", "y"}
          N,          \* writes each stream makes
          MaxCrash,   \* leader changes, over all groups
          MaxDown,    \* times a group loses its majority, over all groups
          MaxMoves,   \* moves the home group may start
          MaxCfg,     \* membership changes, over A and B
          MaxCopy,    \* early copies the target may log
          Locks,      \* do the writes carry lock tokens (x: 1, y: 2)?
          IfVer,      \* is write n+1 sent "only if the row is at write n's version"?
          GrowB,      \* does B start one voter short?
          BackFirst,  \* must the row be written back before the source reopens?
          Strict      \* route mode: a writer sends only where its route says

VARIABLES log,     \* log[g]: the leader's log of group g, tail included
          ci,      \* ci[g]: how much of log[g] is committed
          alt,     \* alt[g]: a dropped tail that may still come back
          up,      \* up[g]: the group has a majority
          route,   \* the writer's cached group for the slot (route mode)
          crashes, downs

vars == <<log, ci, alt, up, route, crashes, downs>>

DG == {"A", "B"}                 \* the groups that hold data
G  == {"A", "B", "H"}            \* H is the home group
Other(g) == IF g = "A" THEN "B" ELSE "A"
Copies == 3                      \* the resource's copies setting

Tok(s)   == IF Locks THEN (IF s = "x" THEN 1 ELSE 2) ELSE 0
Clock(g) == IF g = "A" THEN 2 ELSE 1     \* B's clock runs behind A's

Max(X) == CHOOSE x \in X : \A y \in X : y <= x
PosLess(p, q) == p[1] < q[1] \/ (p[1] = q[1] /\ p[2] < q[2])

CL(g)      == SubSeq(log[g], 1, ci[g])
Idx(L, T)  == {i \in DOMAIN L : L[i].t \in T}
LastOf(L, T) == IF Idx(L, T) = {} THEN 0 ELSE Max(Idx(L, T))
Has(L, t, v) == \E i \in DOMAIN L : L[i].t = t /\ L[i].v = v
IsW(e) == e.t = "w"

(* ---- what a log says about the slot ---- *)
Stops == {"fence", "unf", "final"}
Mode(g, L) ==
    LET k == LastOf(L, Stops) IN
    IF k = 0 THEN (IF g = "A" THEN "open" ELSE "none")
    ELSE IF L[k].t = "fence" THEN "fenced"                      \* @rule slot-move.3
    ELSE "open"                                                 \* @rule slot-move.7

Parts == {"seq", "ep", "hi", "ans", "tok", "ver", "st", "rest"}
NoTab == [seq |-> 0, ep |-> 0, hi |-> [s \in S |-> 0], ans |-> {},
          tok |-> 0, ver |-> <<0, 0>>, st |-> 0, rest |-> FALSE]
InitTab == [NoTab EXCEPT !.ep = 1, !.ver = <<1, 0>>, !.rest = TRUE]

BaseIx(L) == LastOf(L, {"final"})
BaseTab(g, L) ==
    IF BaseIx(L) = 0 THEN (IF g = "A" THEN InitTab ELSE NoTab)
    ELSE L[BaseIx(L)].tab                                       \* @rule stream-numbers.11
WsOf(L) == {i \in DOMAIN L : i > BaseIx(L) /\ L[i].t = "w"}

(* The slot's judging state at the end of L: the carried set's parts. *)
Tab(g, L) ==
    LET B  == BaseTab(g, L)
        W  == WsOf(L)
        Ok == {i \in W : L[i].out = "ok"}
    IN [seq  |-> B.seq + Cardinality(W),
        ep   |-> B.ep,
        hi   |-> [s \in S |-> Max({B.hi[s]} \cup {L[i].n : i \in {j \in W : L[j].s = s}})],
        ans  |-> B.ans \cup {<<L[i].s, L[i].n, L[i].out>> : i \in W},
        tok  |-> Max({B.tok} \cup {L[i].tok : i \in W}),
        ver  |-> IF Ok = {} THEN B.ver ELSE L[Max(Ok)].pos,
        st   |-> Max({B.st} \cup {L[i].st : i \in W}),
        rest |-> B.rest]

(* What a move carries.  One line per part of slot-move.15's list.  "rest"
   stands for the parts that are only carried bytes here: caller keys,
   removal marks, and segment and snapshot names. *)
Carried(T) ==
    [seq  |-> T.seq,                                            \* @rule slot-sequence.2 seq
     ep   |-> T.ep,                                             \* @rule slot-sequence.2 epoch
     hi   |-> T.hi,                                             \* @rule stream-numbers.10 marks
     ans  |-> T.ans,                                            \* @rule stream-numbers.10 answers
     tok  |-> T.tok,                                            \* @rule slot-move.6
     ver  |-> T.ver,                                            \* @rule slot-move.15 versions
     st   |-> T.st,                                             \* @rule writer-time.7 carry
     rest |-> T.rest]                                           \* @rule slot-move.15 rest
Got(parts, p, x, none) == IF p \in parts THEN x ELSE none
Keep(T, parts) ==
    [seq  |-> Got(parts, "seq", T.seq, 0),   ep  |-> Got(parts, "ep", T.ep, 0),
     hi   |-> Got(parts, "hi", T.hi, NoTab.hi), ans |-> Got(parts, "ans", T.ans, {}),
     tok  |-> Got(parts, "tok", T.tok, 0),   ver |-> Got(parts, "ver", T.ver, <<0, 0>>),
     st   |-> Got(parts, "st", T.st, 0),     rest |-> Got(parts, "rest", T.rest, FALSE)]

(* The records a reader sees at the end of L. *)
OwnWs(L) == SelectSeq(SubSeq(L, BaseIx(L) + 1, Len(L)), IsW)
Vis(L)   == IF BaseIx(L) = 0 THEN OwnWs(L) ELSE L[BaseIx(L)].recs \o OwnWs(L)

(* The early copy a target holds, unseen by reads. *)
CopyIx(L) == LET k == LastOf(L, {"copy"}) IN IF k > LastOf(L, Stops) THEN k ELSE 0
Held(L)   == IF CopyIx(L) = 0 THEN <<>> ELSE L[CopyIx(L)].recs

Voters(g, L) == LET k == LastOf(L, {"cfg"}) IN
                IF k = 0 THEN (IF g = "B" /\ GrowB THEN Copies - 1 ELSE Copies)
                ELSE L[k].nv

(* ---- the slot table, read from the home log ---- *)
Row0 == [t |-> "row", m |-> 0, step |-> 0, own |-> "A", src |-> "A"]
RowLeq(r, q) == r.m < q.m \/ (r.m = q.m /\ r.step <= q.step)
Table(L) ==
    LET R == Idx(L, {"row"}) IN
    IF R = {} THEN Row0
    ELSE L[CHOOSE i \in R : \A j \in R : RowLeq(L[j], L[i])]    \* @rule slot-table.6
TopMove(L) == Max({0} \cup {L[i].m : i \in Idx(L, {"row"})})
IsTo(r) == r.m > 0 /\ r.step = 0

(* The last move the home group started has ended, as the home group can
   know it: the row was written back, or the target's final copy committed. *)
Settled ==
    LET T == Table(log["H"]) IN
    \/ ~IsTo(T)                                                 \* @rule ended.back
    \/ Has(CL(T.own), "final", T.m)                             \* @rule ended.open

Init == /\ log = [g \in G |-> <<>>] /\ ci = [g \in G |-> 0]
        /\ alt = [g \in G |-> <<>>] /\ up = [g \in G |-> TRUE]
        /\ route = "A" /\ crashes = 0 /\ downs = 0

Put(g, e) == log' = [log EXCEPT ![g] = Append(@, e)]

(* ---- the committed writes, wherever they are ---- *)
CWI    == UNION {{<<g, i>> : i \in Idx(CL(g), {"w"})} : g \in DG}
Rec(o) == log[o[1]][o[2]]

(* ---- a leader takes a write ---- *)
Take(g, s) ==
    /\ up[g]
    /\ Strict => g = route
    /\ Mode(g, CL(g)) = "open"                                  \* @rule slot-table.1
    /\ Mode(g, log[g]) = "open"                                 \* @rule slot-move.1
    /\ LET L == log[g]
           T == Tab(g, L)
           n == T.hi[s] + 1                                     \* @keeps stream-numbers.4
           prev == {o \in CWI : Rec(o).s = s /\ Rec(o).n = n - 1}
           ifv == IF IfVer /\ n > 1 THEN Rec(CHOOSE o \in prev : TRUE).pos ELSE <<0, 0>>
       IN
       /\ n <= N
       /\ (IfVer /\ n > 1) => prev # {}          \* the writer was told n-1's version
       /\ Tok(s) = 0 \/ Tok(s) >= T.tok                         \* @keeps fence-tokens.1
       /\ Put(g, [t |-> "w", s |-> s, n |-> n,
                  pos |-> <<T.ep, T.seq + 1>>,                  \* @keeps slot-sequence.1
                  tok |-> Tok(s),
                  st  |-> Max({Clock(g), T.st}),                \* @rule writer-time.7 stamp
                  ifv |-> ifv,
                  out |-> IF ifv = <<0, 0>> \/ T.ver = ifv THEN "ok" ELSE "no"])  \* @keeps row-version.1
    /\ UNCHANGED <<ci, alt, up, route, crashes, downs>>

(* ---- the move ---- *)
(* The home group's leader starts a move: the target's row goes in the home
   log.  The row's number names the move. *)
StartMove(d) ==
    /\ up["H"] /\ up[d]
    /\ LET LH == log["H"]
           T  == Table(LH)
       IN
       /\ T.own # d                                             \* @world start.other
       /\ Cardinality({i \in Idx(LH, {"row"}) : IsTo(LH[i])}) < MaxMoves
       /\ Settled                                               \* @world move-policy.4
       /\ Put("H", [t |-> "row", m |-> TopMove(LH) + 1, step |-> 0,
                    own |-> d, src |-> T.own])
    /\ UNCHANGED <<ci, alt, up, route, crashes, downs>>

(* The early copy: the target logs the slot's records up to some committed
   place of the source, unseen by reads. *)
Copy(d) ==
    LET a == Other(d)
        R == Vis(CL(a))                                         \* @rule slot-move.11
        L == log[d]
    IN
    /\ MaxCopy > 0 /\ up[d] /\ up[a]
    /\ Mode(a, CL(a)) = "open" /\ Mode(d, L) # "open"            \* @world copy.server
    /\ Cardinality(Idx(log["A"], {"copy"})) + Cardinality(Idx(log["B"], {"copy"})) < MaxCopy
    /\ \E k \in 1..Len(R) :
         /\ k > Len(Held(L))
         /\ Put(d, [t |-> "copy", recs |-> SubSeq(R, 1, k)])
    /\ UNCHANGED <<ci, alt, up, route, crashes, downs>>

(* The fence: one entry, the decision and the fence at once. *)
Fence(a) ==
    LET d == Other(a)
        L == log[a]
    IN
    /\ up[a]
    /\ Mode(a, CL(a)) = "open"                                  \* @rule slot-move.2
    /\ Mode(a, L) = "open"                                      \* @rule slot-move.1 once
    /\ \E k \in 0..ci["H"] :                                   \* @rule slot-table.4 committed
         LET T == Table(SubSeq(log["H"], 1, k)) IN   \* the table, maybe read stale
         /\ IsTo(T) /\ T.own = d /\ T.src = a                   \* @rule slot-table.4
         /\ ~Has(L, "fence", T.m)                               \* @rule fence.once
         /\ Put(a, [t |-> "fence", v |-> T.m, to |-> d])
    /\ UNCHANGED <<ci, alt, up, route, crashes, downs>>

(* The final copy: one entry at the target; its commit opens the slot. *)
Final(d) ==
    LET a == Other(d)
        L == log[d]
    IN
    /\ up[d] /\ up[a]
    /\ \E i \in 1..ci[a] :                                      \* @rule slot-move.4
         /\ log[a][i].t = "fence" /\ log[a][i].to = d
         /\ LET v  == log[a][i].v
                At == SubSeq(log[a], 1, i - 1)                      \* @rule slot-move.4 at
                R  == Vis(At)
                H0 == Held(L)
            IN
            /\ ~Has(L, "abort", v)                              \* @rule slot-move.18
            /\ ~Has(L, "final", v)                              \* @rule slot-move.8
            /\ Voters(d, L) >= Copies                           \* @rule slot-move.22
            /\ \E parts \in {Parts} :                           \* @rule slot-move.15 whole
                 Put(d, [t |-> "final", v |-> v, src |-> a,
                         recs |-> H0 \o SubSeq(R, Len(H0) + 1, Len(R)),   \* @rule slot-move.5
                         tab  |-> Keep(Carried(Tab(a, At)), parts)])
    /\ UNCHANGED <<ci, alt, up, route, crashes, downs>>

(* The target gives a move up, on a timer: any time before its final copy. *)
Abort(d) ==
    /\ up[d]
    /\ \E k \in 0..ci["H"] :
         LET T == Table(SubSeq(log["H"], 1, k)) IN
         /\ IsTo(T) /\ T.own = d                                \* @rule slot-move.17 target
         /\ ~Has(log[d], "final", T.m)                          \* @rule slot-move.17
         /\ ~Has(log[d], "abort", T.m)
         /\ Put(d, [t |-> "abort", v |-> T.m, src |-> T.src])
    /\ UNCHANGED <<ci, alt, up, route, crashes, downs>>

(* After its abort has committed, the target writes the row back. *)
Back(d) ==
    /\ up["H"] /\ up[d]
    /\ \E j \in 1..ci[d] :                                      \* @rule back.committed
         /\ log[d][j].t = "abort"
         /\ ~ \E i \in DOMAIN log["H"] :
                log["H"][i].t = "row" /\ log["H"][i].m = log[d][j].v /\ log["H"][i].step = 1
         /\ Put("H", [t |-> "row", m |-> log[d][j].v,
                      step |-> 1,
                      own |-> log[d][j].src, src |-> d])
    /\ UNCHANGED <<ci, alt, up, route, crashes, downs>>

BackDone(v) == \E i \in 1..ci["H"] :
                 log["H"][i].t = "row" /\ log["H"][i].m = v /\ log["H"][i].step = 1

(* The source reopens a slot it fenced, on the target's committed abort. *)
Unfence(a) ==
    LET d == Other(a)
        L == log[a]
        k == LastOf(L, Stops)
    IN
    /\ up[a] /\ up[d]
    /\ k > 0 /\ L[k].t = "fence"                 \* the fence is its last word
    /\ k <= ci[a]                                               \* @rule slot-move.19 fenced
    /\ Has(CL(d), "abort", L[k].v)                              \* @rule slot-move.19
    /\ BackFirst => BackDone(L[k].v)                            \* @rule slot-table.5
    /\ Put(a, [t |-> "unf", v |-> L[k].v])                      \* @rule slot-move.20
    /\ UNCHANGED <<ci, alt, up, route, crashes, downs>>

(* ---- a membership change: one entry, in the group's own log ---- *)
Reconf(g) ==
    /\ up[g]
    /\ Cardinality(Idx(log["A"], {"cfg"})) + Cardinality(Idx(log["B"], {"cfg"})) < MaxCfg
    /\ Put(g, [t |-> "cfg",
               nv |-> IF Voters(g, log[g]) = Copies THEN Copies - 1 ELSE Copies])
    /\ UNCHANGED <<ci, alt, up, route, crashes, downs>>

(* ---- the groups ---- *)
Commit(g) ==
    /\ up[g] /\ ci[g] < Len(log[g])
    /\ ci' = [ci EXCEPT ![g] = @ + 1]
    /\ alt' = [alt EXCEPT ![g] = <<>>]
    /\ UNCHANGED <<log, up, route, crashes, downs>>

TailOf(g) == SubSeq(log[g], ci[g] + 1, Len(log[g]))

(* A leader change: the new leader has the committed part and any prefix of
   the tail.  The dropped tail may come back with a later leader. *)
Crash(g) ==
    /\ crashes < MaxCrash /\ TailOf(g) # <<>>
    /\ \E k \in 0..(Len(TailOf(g)) - 1) :
         log' = [log EXCEPT ![g] = CL(g) \o SubSeq(TailOf(g), 1, k)]
    /\ alt' = [alt EXCEPT ![g] = TailOf(g)]
    /\ crashes' = crashes + 1
    /\ UNCHANGED <<ci, up, route, downs>>

Revive(g) ==
    /\ crashes < MaxCrash /\ alt[g] # <<>> /\ alt[g] # TailOf(g)
    /\ log' = [log EXCEPT ![g] = CL(g) \o alt[g]]
    /\ alt' = [alt EXCEPT ![g] = TailOf(g)]
    /\ crashes' = crashes + 1
    /\ UNCHANGED <<ci, up, route, downs>>

(* Two faults among three voters: no majority.  The group stops, then returns. *)
Down(g) ==
    /\ up[g] /\ downs < MaxDown
    /\ up' = [up EXCEPT ![g] = FALSE] /\ downs' = downs + 1
    /\ UNCHANGED <<log, ci, alt, route, crashes>>

Up(g) ==
    /\ ~up[g]
    /\ up' = [up EXCEPT ![g] = TRUE]
    /\ UNCHANGED <<log, ci, alt, route, crashes, downs>>

(* ---- routes (route mode only) ---- *)
(* Where a group that does not serve the slot sends a writer. *)
Where(g) ==
    LET L == CL(g)
        T == Table(CL("H"))                      \* its copy of the home records
    IN
    IF Mode(g, L) = "fenced" THEN L[LastOf(L, Stops)].to        \* @rule moved.fence
    ELSE IF T.own # g THEN T.own                                \* @keeps home-records.2
    ELSE IF IsTo(T) /\ Has(L, "abort", T.m) THEN T.src          \* @rule moved.abort
    ELSE g                                       \* the answer is retry: slot-move.9

Ask(g) ==
    /\ Strict /\ up[g] /\ g = route
    /\ Mode(g, CL(g)) # "open"
    /\ Where(g) # g
    /\ route' = Where(g)
    /\ UNCHANGED <<log, ci, alt, up, crashes, downs>>

(* A writer with an old route: a late copy, or a new client's stale table. *)
StaleRoute ==
    /\ Strict
    /\ route' = Other(route)
    /\ UNCHANGED <<log, ci, alt, up, crashes, downs>>

Next == \/ \E g \in DG, s \in S : Take(g, s)
        \/ \E g \in DG : StartMove(g) \/ Copy(g) \/ Fence(g) \/ Final(g)
        \/ \E g \in DG : Abort(g) \/ Back(g) \/ Unfence(g) \/ Reconf(g)
        \/ \E g \in G : Commit(g) \/ Crash(g) \/ Revive(g) \/ Down(g) \/ Up(g)
        \/ \E g \in DG : Ask(g)
        \/ StaleRoute

Spec == Init /\ [][Next]_vars

(* ================= the properties ================= *)
Serves(g) == Mode(g, CL(g)) = "open"
Server    == {g \in DG : Serves(g)}
K         == Cardinality(CWI)

\* A position (slot, epoch, sequence) never names two records, and the
\* positions are 1, 2, 3, ... in the slot's one epoch.
PosUnique == /\ \A o, q \in CWI : o # q => Rec(o).pos # Rec(q).pos
             /\ {Rec(o).pos : o \in CWI} = {<<1, i>> : i \in 1..K}

\* No write is applied twice.
Once == \A o, q \in CWI : o # q => ~(Rec(o).s = Rec(q).s /\ Rec(o).n = Rec(q).n)

\* Each stream's writes are committed in order with no gap: by position,
\* its numbers are 1, 2, 3, ...
InOrder == \A o \in CWI :
             Rec(o).n = 1 + Cardinality({q \in CWI : /\ Rec(q).s = Rec(o).s
                                                     /\ PosLess(Rec(q).pos, Rec(o).pos)})

\* At most one group serves the slot's writes.
OneServer == Cardinality(Server) <= 1

\* The same at the leaders' log ends, where writes are taken: at most one
\* group's log, tail included, holds the slot open.
OneTaker == Cardinality({g \in DG : Mode(g, log[g]) = "open"}) <= 1

\* The slot's one history: the committed writes, by position.
Canon == [i \in 1..K |-> Rec(CHOOSE o \in CWI : Rec(o).pos = <<1, i>>)]
IsPrefix(a, b) == Len(a) <= Len(b) /\ SubSeq(b, 1, Len(a)) = a

\* No write is lost, and reads never see the slot go back: what any group
\* shows is the first part of the one history, and the group that serves
\* shows all of it.
Views == PosUnique =>
           \A g \in DG : /\ IsPrefix(Vis(CL(g)), Canon)
                         /\ Serves(g) => Vis(CL(g)) = Canon

\* An early copy holds only committed records, in order.
CopyTrue == PosUnique => \A g \in DG : IsPrefix(Held(CL(g)), Canon)

\* A repeat of a committed write gets its first answer from the group that
\* serves: the kept answers came with the slot.
AnswersKept == \A g \in Server : \A o \in CWI :
                 <<Rec(o).s, Rec(o).n, Rec(o).out>> \in Tab(g, CL(g)).ans

\* A write under an older lock token never lands after a newer one.
TokOrder == \A o, q \in CWI :
              (PosLess(Rec(o).pos, Rec(q).pos) /\ Rec(o).tok > 0 /\ Rec(q).tok > 0)
                => Rec(o).tok <= Rec(q).tok

\* The slot's stamps never go back.
StampOrder == \A o, q \in CWI : PosLess(Rec(o).pos, Rec(q).pos) => Rec(o).st <= Rec(q).st

\* A write sent "only if the row is at version v" is applied exactly when
\* the row was at v in the one history.
VerBefore(o) == LET B == {q \in CWI : PosLess(Rec(q).pos, Rec(o).pos) /\ Rec(q).out = "ok"} IN
                IF B = {} THEN <<1, 0>>
                ELSE Rec(CHOOSE q \in B : \A r \in B : ~PosLess(Rec(q).pos, Rec(r).pos)).pos
VerRight == \A o \in CWI :
              Rec(o).ifv # <<0, 0>> => (Rec(o).out = "ok" <=> Rec(o).ifv = VerBefore(o))

\* The table is never behind an open: a served slot's row names its server,
\* or names the target of a move that has not opened.  A committed final
\* copy has its row; a committed reopen has its row written back.
RowIn(m, step, own) == \E i \in 1..ci["H"] :
    /\ log["H"][i].t = "row" /\ log["H"][i].m = m
    /\ log["H"][i].step = step /\ log["H"][i].own = own
TableRight ==
    /\ \A g \in Server :
         LET T == Table(CL("H")) IN
         \/ T.own = g
         \/ IsTo(T) /\ T.src = g /\ ~Has(CL(T.own), "final", T.m)
    /\ \A g \in DG : \A i \in 1..ci[g] :
         /\ log[g][i].t = "final" => RowIn(log[g][i].v, 0, g)
         /\ (BackFirst /\ log[g][i].t = "unf") => RowIn(log[g][i].v, 1, g)

\* The row comes first: every entry of a move, in any log, committed or not,
\* names a move whose row has committed in the home log.  So a target that
\* has not written the row never meets a fence.
RowFirst == \A g \in DG : \A i \in DOMAIN log[g] :
              log[g][i].t \in {"fence", "final", "abort", "unf"} =>
                \E j \in 1..ci["H"] : /\ log["H"][j].t = "row" /\ log["H"][j].step = 0
                                      /\ log["H"][j].m = log[g][i].v

\* No slot opens in a group that has fewer voters than the copies setting.
OpenFull == \A g \in DG : \A i \in DOMAIN log[g] :
              log[g][i].t = "final" => Voters(g, SubSeq(log[g], 1, i - 1)) >= Copies

\* The target opens only with every part of the carried set: a committed
\* final copy holds the source's whole state at the fence.
Whole == \A g \in DG : \A i \in 1..ci[g] :
           log[g][i].t = "final" =>
             LET a == log[g][i].src
                 F == {j \in 1..ci[a] : log[a][j].t = "fence" /\ log[a][j].v = log[g][i].v}
             IN /\ F # {}
                /\ \A j \in F :
                     /\ log[g][i].tab  = Tab(a, SubSeq(log[a], 1, j - 1))
                     /\ log[g][i].recs = Vis(SubSeq(log[a], 1, j - 1))

(* ---- reach checks: each must FAIL, to show the model can get there ---- *)
AllIn      == K = N * Cardinality(S)
MovedTo(g) == \E i \in 1..ci[g] : /\ log[g][i].t = "final"
                                  /\ \E j \in (i + 1)..ci[g] : log[g][j].t = "w"
CfgBefore(g, t) == \E i, j \in 1..ci[g] : i < j /\ log[g][i].t = "cfg" /\ log[g][j].t = t
\* a move completes and every write lands
NotMoved == ~(MovedTo("B") /\ AllIn)
\* a move is given up and the source takes writes again
NotBack  == ~(\E i \in 1..ci["A"] : /\ log["A"][i].t = "unf"
                                    /\ \E j \in (i + 1)..ci["A"] : log["A"][j].t = "w")
\* the slot moves there and back
NotTwice == ~(MovedTo("A") /\ AllIn)
\* a move completes with the home group down from before the fence, a
\* membership change in both groups on the way, a data group that lost its
\* majority and returned, and a leader change
NotHard  == ~(/\ MovedTo("B") /\ AllIn /\ ~up["H"]
              /\ CfgBefore("A", "fence") /\ CfgBefore("B", "final")
              /\ downs >= 2 /\ crashes >= 1)
\* used with NotHard: a fence is logged only while the home group is down,
\* and the home group does not return
HardWay == /\ (\E g \in DG : /\ Len(log'[g]) > Len(log[g])
                             /\ log'[g][Len(log'[g])].t = "fence") => ~up["H"]
           /\ ~up["H"] => ~up'["H"]
=============================================================================
