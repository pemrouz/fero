---------------------------- MODULE SlotMoveMsg ----------------------------
(* The one-commit slot move, second model: stored reports, an unclean
   recovery, and the carried set sent early.

   SlotMove.tla reads every report from a committed log, because there a
   committed fact stays true.  An unclean recovery breaks that: the
   operator's recover command restarts a group from the copies that answer,
   and committed entries may be gone.  So here every report of a data group
   is a stored fact: it is written down the moment its entry commits, and a
   step may read it at any later time, any number of times, or never.  That
   is a late, a repeated and a lost message.

   What this model adds to SlotMove.tla:
     - the recovery: a group's log becomes any part of its committed log,
       its tail is gone, and its incarnation (the number of its lives, kept
       in the home log) goes up by one;
     - the slot's epoch moves: a group that reopens a slot after a recovery
       does it in a new epoch, handed out by the home log;
     - the ready report: the target reports the place its early copy
       reached, and the source's fence names that place;
     - the carried set sent early: the early copy holds the carried set as
       of its place; the final copy brings only what changed since, and the
       target merges the two;
     - the END flag: only a final copy carries it.

   What it leaves to SlotMove.tla: lock tokens, row versions, stamps, the
   membership change, a data group with no majority, routes.  The home log
   is committed rows only here; it may be down.

   Marks as in SlotMove.tla:  \* @rule <id>,  \* @keeps <id>,  \* @world. *)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS S,          \* the streams
          N,          \* writes each stream makes
          MaxCrash,   \* leader changes, over the data groups
          MaxRec,     \* unclean recoveries, over the data groups
          MaxMoves,   \* moves the home group may start
          MaxCopy,    \* early copies a target may log
          MaxDown,    \* times the home group loses its majority
          NeedReady,  \* must the source wait for a ready report?
          BackFirst   \* must the row be written back before any reopen?

VARIABLES log,     \* log[g]: the leader's log of data group g, tail included
          ci,      \* ci[g]: how much of log[g] is committed
          inc,     \* inc[g]: the group's incarnation, as the home log holds it
          home,    \* the home log's committed slot-table rows, in order
          hup,     \* the home group has a majority
          said,    \* every report a data group ever made
          ever,    \* (for the checks) every write record ever committed
          seen,    \* (for the checks) the last view a server showed
          went,    \* (for the checks) a served view went back in one epoch
          crashes, recs, downs

vars == <<log, ci, inc, home, hup, said, ever, seen, went, crashes, recs, downs>>

DG == {"A", "B"}
Other(g) == IF g = "A" THEN "B" ELSE "A"
Max(X) == CHOOSE x \in X : \A y \in X : y <= x
PosLess(p, q) == p[1] < q[1] \/ (p[1] = q[1] /\ p[2] < q[2])
IsPrefix(a, b) == Len(a) <= Len(b) /\ SubSeq(b, 1, Len(a)) = a

CL(g)        == SubSeq(log[g], 1, ci[g])
Idx(L, T)    == {i \in DOMAIN L : L[i].t \in T}
LastOf(L, T) == IF Idx(L, T) = {} THEN 0 ELSE Max(Idx(L, T))
Has(L, t, v) == \E i \in DOMAIN L : L[i].t = t /\ L[i].v = v
IsW(e) == e.t = "w"

(* ---- what a log says about the slot ---- *)
Stops == {"fence", "unf", "final", "rec", "reopen"}
ModeBy(g, L, T) ==
    LET k == LastOf(L, T) IN
    IF k = 0 THEN (IF g = "A" THEN "open" ELSE "none")
    ELSE IF L[k].t = "fence" THEN "fenced"                      \* @rule slot-move.3
    ELSE IF L[k].t = "rec" THEN "shut"                          \* @rule recover.shut
    ELSE "open"
Mode(g, L) == ModeBy(g, L, Stops)
\* the group's copy holds the slot's records, whatever a recovery did since
Holds(g, L) == ModeBy(g, L, Stops \ {"rec"}) \in {"open", "fenced"}

NoTab   == [seq |-> 0, ep |-> 0, hi |-> [s \in S |-> 0], ans |-> {}, rest |-> FALSE]
InitTab == [NoTab EXCEPT !.ep = 1, !.rest = TRUE]

BaseIx(L) == LastOf(L, {"final"})
BaseTab(g, L) == IF BaseIx(L) = 0 THEN (IF g = "A" THEN InitTab ELSE NoTab)
                 ELSE L[BaseIx(L)].tab                          \* @rule stream-numbers.11
WsOf(L) == {i \in DOMAIN L : i > BaseIx(L) /\ L[i].t = "w"}
\* the slot's epoch: set by a final copy, a reopen, or a recovery's reopen
EpIx(L) == LastOf(L, {"final", "unf", "reopen"})
EpOf(g, L) == IF EpIx(L) = 0 THEN BaseTab(g, L).ep ELSE L[EpIx(L)].ep

(* The slot's judging state at the end of L.  "rest" stands for the parts
   that are only carried bytes here. *)
Tab(g, L) ==
    LET B == BaseTab(g, L)
        W == WsOf(L)
    IN [seq  |-> B.seq + Cardinality(W),
        ep   |-> EpOf(g, L),
        hi   |-> [s \in S |-> Max({B.hi[s]} \cup {L[i].n : i \in {j \in W : L[j].s = s}})],
        ans  |-> B.ans \cup {<<L[i].s, L[i].n>> : i \in W},
        rest |-> B.rest]

OwnWs(L) == SelectSeq(SubSeq(L, BaseIx(L) + 1, Len(L)), IsW)
Vis(L)   == IF BaseIx(L) = 0 THEN OwnWs(L) ELSE L[BaseIx(L)].recs \o OwnWs(L)

(* What changed in the carried set between two places, and the merge. *)
Delta(T0, T1) ==
    [seq  |-> T1.seq,                                           \* @rule slot-sequence.2 seq
     ep   |-> T1.ep,                                            \* @rule slot-sequence.2 epoch
     hi   |-> [s \in S |-> IF T1.hi[s] # T0.hi[s] THEN T1.hi[s] ELSE 0],   \* @rule delta.marks
     ans  |-> T1.ans \ T0.ans,                                  \* @rule delta.answers
     rest |-> T1.rest /\ ~T0.rest]                              \* @rule delta.rest
Merge(C, D) ==
    [seq  |-> D.seq,                                            \* @rule merge.seq
     ep   |-> D.ep,                                             \* @rule merge.epoch
     hi   |-> [s \in S |-> Max({C.hi[s], D.hi[s]})],            \* @rule merge.marks
     ans  |-> C.ans \cup D.ans,                                 \* @rule merge.answers
     rest |-> C.rest \/ D.rest]                                 \* @rule merge.rest

\* the newest early copy a log holds for move m
HeldIx(L, m) == LET C == {i \in DOMAIN L : L[i].t = "copy" /\ L[i].v = m} IN
                IF C = {} THEN 0 ELSE Max(C)

(* ---- the slot table: committed rows of the home log ---- *)
\* step 0: a move's row; step 1: the row written back; step 2: a recovery's row
\* "for" names the move a written-back row ends; it is the row's own number
\* but for a row written back after a lost target
Row0 == [m |-> 0, step |-> 1, own |-> "A", src |-> "A", ep |-> 1, sinc |-> 0, dinc |-> 0, for |-> 0]
RowLeq(r, q) == r.m < q.m \/ (r.m = q.m /\ r.step <= q.step)
Table(Hm) ==
    IF Hm = <<>> THEN Row0
    ELSE Hm[CHOOSE i \in DOMAIN Hm : \A j \in DOMAIN Hm : RowLeq(Hm[j], Hm[i])]   \* @rule slot-table.6
TopM(Hm)  == Max({0} \cup {Hm[i].m : i \in DOMAIN Hm})
TopEp(Hm) == Max({1} \cup {Hm[i].ep : i \in DOMAIN Hm})
IsTo(r)   == r.step = 0
Said(k)   == {f \in said : f.k = k}

(* The last move has ended, as the home group can know it. *)
Settled ==
    LET T == Table(home) IN
    \/ ~IsTo(T)                                                 \* @rule ended.back
    \/ /\ \E f \in Said("final") : f.m = T.m                    \* @rule ended.open
       /\ inc[T.own] = T.dinc                                   \* @rule ended.inc

Init == /\ log = [g \in DG |-> <<>>] /\ ci = [g \in DG |-> 0]
        /\ inc = [g \in DG |-> 0] /\ home = <<>> /\ hup = TRUE
        /\ said = {} /\ ever = {} /\ seen = [vis |-> <<>>, ep |-> 1] /\ went = FALSE
        /\ crashes = 0 /\ recs = 0 /\ downs = 0

Put(g, e) == log' = [log EXCEPT ![g] = Append(@, e)]
Same      == UNCHANGED <<ci, inc, home, hup, said, ever, crashes, recs, downs>>
SameH     == UNCHANGED <<log, ci, inc, hup, said, ever, crashes, recs, downs>>

(* ---- a leader takes a write ---- *)
Take(g, s) ==
    /\ Mode(g, CL(g)) = "open"                                  \* @rule slot-table.1
    /\ Mode(g, log[g]) = "open"                                 \* @rule slot-move.1
    /\ LET T == Tab(g, log[g])
           n == T.hi[s] + 1                                     \* @keeps stream-numbers.4
       IN /\ n <= N
          /\ Put(g, [t |-> "w", s |-> s, n |-> n,
                     pos |-> <<T.ep, T.seq + 1>>,               \* @keeps slot-sequence.1
                     by  |-> <<g, inc[g]>>])
    /\ Same

(* ---- the move ---- *)
(* The row names the move, and both groups' incarnations as the home log
   holds them when the row is written. *)
StartMove(d) ==
    /\ hup
    /\ LET T == Table(home) IN
       /\ T.own # d
       /\ Cardinality({i \in DOMAIN home : IsTo(home[i])}) < MaxMoves
       /\ Settled                                               \* @rule move-policy.4
       /\ home' = Append(home, [m |-> TopM(home) + 1, step |-> 0, own |-> d, src |-> T.own,
                                ep |-> T.ep, for |-> 0,
                                sinc |-> inc[T.own],            \* @rule row.inc write-src
                                dinc |-> inc[d]])               \* @rule row.inc write-dst
    /\ SameH

(* The early copy: the slot's records and its carried set up to some
   committed place of the source, unseen by reads.  When it commits, the
   target's report "ready, at place p" exists. *)
Copy(d) ==
    LET L == log[d] IN
    /\ \E k \in 0..Len(home) :
         LET T == Table(SubSeq(home, 1, k))      \* the table, maybe read stale
             a == T.src
         IN
         /\ IsTo(T) /\ T.own = d
         /\ T.dinc = inc[d]                                     \* @rule row.inc copy
         /\ ~Has(L, "abort", T.m) /\ ~Has(L, "final", T.m)
         /\ Cardinality({i \in DOMAIN L : L[i].t = "copy" /\ L[i].v = T.m}) < MaxCopy
         /\ \E i \in 0..ci[a] :                                 \* @rule slot-move.11
              LET At == SubSeq(log[a], 1, i)
                  p  == Len(Vis(At))
              IN
              /\ Mode(a, At) = "open"                           \* @world copy.server
              /\ IF HeldIx(L, T.m) = 0 THEN TRUE ELSE p > L[HeldIx(L, T.m)].p   \* @rule copy.forward
              /\ Put(d, [t |-> "copy", v |-> T.m, p |-> p, recs |-> Vis(At),
                         tab |-> Tab(a, At)])                   \* @rule slot-move.13 early
    /\ Same

(* The fence.  It names the move, the target's incarnation, and the base:
   the place the target reported, plus one; 0 means "send everything". *)
\* the entries that name a row of the table: a move's, or a recovery's
MoveEntries == {"fence", "unf", "final", "abort", "copy", "reopen"}
Ready(m) == {f \in Said("ready") : f.m = m}
Fence(a) ==
    LET d == Other(a)
        L == log[a]
    IN
    /\ Mode(a, CL(a)) = "open"                                  \* @rule slot-move.2
    /\ Mode(a, L) = "open"                                      \* @rule slot-move.1 once
    /\ \E k \in 0..Len(home) :
         LET T == Table(SubSeq(home, 1, k)) IN
         /\ IsTo(T) /\ T.own = d /\ T.src = a                   \* @rule slot-table.4
         /\ T.sinc = inc[a]                                     \* @rule row.inc source
         /\ \A i \in DOMAIN L : L[i].t \in MoveEntries => L[i].v < T.m   \* @rule fence.newer
         /\ \E b \in {0} \cup {f.p + 1 : f \in Ready(T.m)} :    \* @rule slot-move.12
              /\ NeedReady => b > 0                             \* @world slot-move.12 wait
              /\ Put(a, [t |-> "fence", v |-> T.m, to |-> d, base |-> b, dinc |-> T.dinc])
    /\ Same

\* the source's carried set when its view held exactly p records
TabAt(a, L, p) == Tab(a, SubSeq(L, 1, CHOOSE j \in 0..Len(L) : Len(Vis(SubSeq(L, 1, j))) = p))

(* The report a committed fence makes: the final copy as the source sends
   it.  "full" and "frecs" are for the checks only. *)
FenceFact(a, i) ==
    LET e  == log[a][i]
        At == SubSeq(log[a], 1, i - 1)                          \* @rule slot-move.4 at
        R  == Vis(At)
        T1 == Tab(a, At)
        p  == IF e.base = 0 THEN 0 ELSE e.base - 1              \* @rule delta.base source
        T0 == IF e.base = 0 THEN NoTab ELSE TabAt(a, At, p)
    IN [k |-> "fence", m |-> e.v, g |-> a, to |-> e.to, dinc |-> e.dinc, base |-> e.base,
        drecs |-> SubSeq(R, p + 1, Len(R)),                     \* @rule slot-move.5
        dtab  |-> Delta(T0, T1),
        full  |-> T1, frecs |-> R, end |-> TRUE]                \* @rule slot-move.14 mark

\* an early-copy message, as it would look to a target that took it for a final copy
Snap(a, i, T) ==
    LET At == SubSeq(log[a], 1, i) IN
    [k |-> "fence", m |-> T.m, g |-> a, to |-> T.own, dinc |-> T.dinc, base |-> 0,
     drecs |-> Vis(At), dtab |-> Delta(NoTab, Tab(a, At)),
     full |-> Tab(a, At), frecs |-> Vis(At), end |-> FALSE]
Cands(d) ==
    LET T == Table(home) IN
    {f \in Said("fence") : f.to = d}
      \cup (IF IsTo(T) /\ T.own = d THEN {Snap(T.src, i, T) : i \in 0..ci[T.src]} ELSE {})

(* The final copy: one entry at the target; its commit opens the slot. *)
Final(d) ==
    LET L == log[d] IN
    /\ \E f \in Cands(d) :                                      \* @rule slot-move.4
         LET h == HeldIx(L, f.m) IN
         /\ f.end                                               \* @rule slot-move.14
         /\ f.dinc = inc[d]                                     \* @rule row.inc target
         /\ ~Has(L, "abort", f.m)                               \* @rule slot-move.18
         /\ ~Has(L, "final", f.m)                               \* @rule slot-move.8
         /\ Mode(d, L) # "open"                                 \* @rule final.shut
         /\ \A i \in DOMAIN L : L[i].t \in {"fence", "unf", "final", "reopen"} => L[i].v < f.m   \* @rule final.newer
         /\ f.base = 0 \/ (h > 0 /\ L[h].p = f.base - 1)        \* @rule delta.base
         /\ Put(d, [t |-> "final", v |-> f.m, src |-> f.g, base |-> f.base,
                    ep   |-> f.dtab.ep,
                    recs |-> IF f.base = 0 THEN f.drecs ELSE L[h].recs \o f.drecs,
                    tab  |-> IF f.base = 0 THEN Merge(NoTab, f.dtab)
                             ELSE Merge(L[h].tab, f.dtab)])     \* @rule slot-move.13 merge
    /\ Same

(* The target gives a move up.  If it is not the incarnation the row names,
   it says so: what that incarnation did may be lost. *)
Abort(d) ==
    /\ \E k \in 0..Len(home) :
         LET T == Table(SubSeq(home, 1, k)) IN
         /\ IsTo(T) /\ T.own = d                                \* @rule slot-move.17 target
         /\ ~Has(log[d], "final", T.m)                          \* @rule slot-move.17
         /\ ~Has(log[d], "abort", T.m)
         /\ Put(d, [t |-> "abort", v |-> T.m, src |-> T.src,
                    lost |-> T.dinc # inc[d]])                  \* @rule abort.lost
    /\ Same

(* The home group writes the row back on a target's abort report.  If the
   target lost its life, and the table still has the slot at that target by
   that move, the row is a new one: above every other, at a new epoch. *)
LastInto(g) == Max({0} \cup {home[i].m : i \in {j \in DOMAIN home : IsTo(home[j]) /\ home[j].own = g}})
Back ==
    /\ hup
    /\ \E f \in Said("abort") :                                 \* @rule back.committed
         LET T   == Table(home)
             top == /\ f.lost                                   \* @rule back.lost
                    /\ LastInto(f.g) = f.m                      \* @rule back.lost last
                    /\ \/ T.own = f.g /\ (T.step # 2 \/ T.sinc # inc[f.g])   \* @rule back.lost holder
                       \/ IsTo(T) /\ T.src = f.g               \* @rule back.lost giver
         IN
         /\ ~ \E i \in DOMAIN home : home[i].for = f.m /\ home[i].step = 1
         /\ \E j \in DOMAIN home :
              /\ home[j].m = f.m /\ home[j].step = 0
              /\ home' = Append(home,
                   [m    |-> IF top THEN TopM(home) + 1 ELSE f.m,          \* @rule back.lost top
                    step |-> 1, own |-> f.src, src |-> f.g, for |-> f.m,
                    ep   |-> IF top THEN TopEp(home) + 1 ELSE home[j].ep,  \* @rule back.epoch
                    sinc |-> 0, dinc |-> 0])
    /\ SameH

(* The source reopens a slot it fenced, on the target's abort report. *)
Unfence(a) ==
    LET L == log[a]
        k == LastOf(L, Stops)
    IN
    /\ k > 0 /\ L[k].t = "fence"
    /\ k <= ci[a]                                               \* @rule slot-move.19 fenced
    /\ \E f \in Said("abort") :
         LET rows == {i \in DOMAIN home : home[i].for = f.m /\ home[i].step = 1} IN
         /\ f.m = L[k].v /\ f.g = L[k].to                       \* @rule slot-move.19
         /\ BackFirst => rows # {}                              \* @rule slot-table.5
         /\ f.lost => rows # {}                                 \* @rule unf.wait
         /\ Put(a, [t |-> "unf", v |-> L[k].v,
                    ep |-> IF f.lost THEN home[CHOOSE i \in rows : TRUE].ep   \* @rule unf.epoch
                           ELSE EpOf(a, L)])
    /\ Same

(* ---- the groups ---- *)
Commit(g) ==
    /\ ci[g] < Len(log[g])
    /\ LET i == ci[g] + 1
           e == log[g][i]
       IN
       /\ ci' = [ci EXCEPT ![g] = i]
       /\ said' = said \cup
            (CASE e.t = "fence" -> {FenceFact(g, i)}
               [] e.t = "abort" -> {[k |-> "abort", m |-> e.v, g |-> g, src |-> e.src, lost |-> e.lost]}
               [] e.t = "final" -> {[k |-> "final", m |-> e.v]}
               [] e.t = "copy"  -> {[k |-> "ready", m |-> e.v, p |-> e.p]}   \* @rule slot-move.12 report
               [] OTHER -> {})
       /\ ever' = IF e.t = "w" THEN ever \cup {e} ELSE ever
    /\ UNCHANGED <<log, inc, home, hup, crashes, recs, downs>>

(* A leader change: the new leader has the committed part and any part of
   the tail. *)
Crash(g) ==
    /\ crashes < MaxCrash /\ ci[g] < Len(log[g])
    /\ \E k \in ci[g]..(Len(log[g]) - 1) :
         log' = [log EXCEPT ![g] = SubSeq(@, 1, k)]
    /\ crashes' = crashes + 1
    /\ UNCHANGED <<ci, inc, home, hup, said, ever, recs, downs>>

(* The operator's recover command: the group restarts from the copies that
   answer.  Its log is any part of its committed log; the tail is gone; its
   incarnation goes up in the home log; the slot is shut there. *)
Recover(g) ==
    /\ recs < MaxRec /\ hup
    /\ \E k \in 0..ci[g] :
         /\ log' = [log EXCEPT ![g] = Append(SubSeq(@, 1, k), [t |-> "rec", v |-> inc[g] + 1])]
         /\ ci' = [ci EXCEPT ![g] = k + 1]
    /\ inc' = [inc EXCEPT ![g] = @ + 1]                         \* @keeps meta-directory.2
    /\ recs' = recs + 1
    /\ UNCHANGED <<home, hup, said, ever, crashes, downs>>

(* A recovered group asks for the slot's row at a new epoch.  The home
   group's leader checks the request against its own table. *)
RecRow(g) ==
    LET L == CL(g)
        k == LastOf(L, Stops)
        T == Table(home)
    IN
    /\ hup
    /\ k > 0 /\ L[k].t = "rec"
    /\ Holds(g, L)                                              \* @rule recover.copy
    /\ T.own = g                                                \* @rule recover.table
    /\ LastInto(g) = 0 \/ Has(L, "final", LastInto(g))          \* @rule recover.final
    /\ ~ \E i \in DOMAIN home : home[i].step = 2 /\ home[i].own = g /\ home[i].sinc = inc[g]
    /\ home' = Append(home, [m |-> TopM(home) + 1, step |-> 2, own |-> g, src |-> g, for |-> 0,
                             ep |-> TopEp(home) + 1,            \* @rule slot-table.7
                             sinc |-> inc[g], dinc |-> inc[g]])
    /\ SameH

(* The recovered group reopens the slot in its row's epoch. *)
Reopen(g) ==
    LET L == log[g]
        k == LastOf(L, Stops)
    IN
    /\ k > 0 /\ L[k].t = "rec"
    /\ \E i \in DOMAIN home :
         /\ home[i].step = 2 /\ home[i].own = g
         /\ home[i].sinc = inc[g]                               \* @rule recover.row
         /\ Put(g, [t |-> "reopen", v |-> home[i].m, ep |-> home[i].ep])   \* @rule recover.epoch
    /\ Same

HDown == /\ hup /\ downs < MaxDown /\ hup' = FALSE /\ downs' = downs + 1
         /\ UNCHANGED <<log, ci, inc, home, said, ever, crashes, recs>>
HUp   == /\ ~hup /\ hup' = TRUE
         /\ UNCHANGED <<log, ci, inc, home, said, ever, crashes, recs, downs>>

(* ---- the watcher: the last view a server showed ---- *)
ServerOf(lg, c) == {g \in DG : Mode(g, SubSeq(lg[g], 1, c[g])) = "open"}
Watch ==
    LET Sv == ServerOf(log', ci') IN
    IF Sv = {} THEN UNCHANGED <<seen, went>>
    ELSE LET g == CHOOSE x \in Sv : TRUE
             L == SubSeq(log'[g], 1, ci'[g])
         IN /\ seen' = [vis |-> Vis(L), ep |-> Tab(g, L).ep]
            /\ went' = (went \/ ~(IsPrefix(seen.vis, Vis(L)) \/ Tab(g, L).ep > seen.ep))

Step == \/ \E g \in DG, s \in S : Take(g, s)
        \/ \E g \in DG : StartMove(g) \/ Copy(g) \/ Fence(g) \/ Final(g)
        \/ \E g \in DG : Abort(g) \/ Unfence(g) \/ Commit(g) \/ Crash(g)
        \/ \E g \in DG : Recover(g) \/ RecRow(g) \/ Reopen(g)
        \/ Back \/ HDown \/ HUp
Next == Step /\ Watch

Spec == Init /\ [][Next]_vars

(* ================= the properties ================= *)
Serves(g) == Mode(g, CL(g)) = "open"
Server    == {g \in DG : Serves(g)}

\* A position (slot, epoch, sequence) never names two records, lost ones
\* counted: a record is its stream, its number, and the group life that
\* stamped it.
PosUnique == \A r, q \in ever : r.pos = q.pos => r = q

\* At most one group serves the slot's writes; at most one log end holds it open.
OneServer == Cardinality(Server) <= 1
OneTaker  == Cardinality({g \in DG : Mode(g, log[g]) = "open"}) <= 1

\* What any group shows is in order: each stream's numbers are 1, 2, 3, ...
\* with no write twice; the positions only rise; and the i-th record holds
\* sequence i, in whatever epoch.
InOrder == \A g \in DG :
    LET V == Vis(CL(g)) IN
    \A i \in DOMAIN V :
      /\ V[i].n = 1 + Cardinality({j \in 1..(i - 1) : V[j].s = V[i].s})
      /\ \A j \in 1..(i - 1) : PosLess(V[j].pos, V[i].pos)
      /\ V[i].pos[2] = i

\* The group that serves judges by the right state: the sequence, each
\* stream's high mark, the kept answers and the rest all match its records.
StateRight == \A g \in Server :
    LET V == Vis(CL(g))
        T == Tab(g, CL(g))
    IN /\ T.seq = Len(V)
       /\ \A s \in S : T.hi[s] = Cardinality({i \in DOMAIN V : V[i].s = s})
       /\ T.ans = {<<V[i].s, V[i].n>> : i \in DOMAIN V}
       /\ T.rest

\* With no recovery, no write is lost: the server shows every write that
\* ever committed.
NoLoss == (recs = 0) => \A g \in Server :
            LET V == Vis(CL(g)) IN {V[i] : i \in DOMAIN V} = ever

\* Reads never see the slot go back inside one epoch.
NoBack == ~went

\* The table is never behind an open, and every epoch a group serves in
\* is one the home log knows, so the next epoch it hands out is new.
TableRight ==
    /\ \A g \in Server :
         LET T == Table(home) IN
         /\ Tab(g, CL(g)).ep <= TopEp(home)
         /\ T.own = g \/ (IsTo(T) /\ T.src = g)
    /\ \A g \in DG : \A i \in DOMAIN log[g] :
         log[g][i].t \in {"fence", "final", "abort", "unf"} =>
           \E j \in DOMAIN home : home[j].m = log[g][i].v /\ home[j].step = 0

\* The target opens only with every part: a committed final copy holds the
\* source's whole state at the fence.
Whole == \A g \in DG : \A i \in 1..ci[g] :
           log[g][i].t = "final" =>
             \E f \in Said("fence") : /\ f.m = log[g][i].v
                                      /\ log[g][i].tab = f.full
                                      /\ log[g][i].recs = f.frecs

(* ---- reach checks: each must FAIL ---- *)
WAfter(g, t) == \E i, j \in 1..ci[g] : i < j /\ log[g][i].t = t /\ log[g][j].t = "w"
\* a move completes from an early copy that held a record, with a delta
\* that brought a record, and the target takes a write
NotEarly == ~(\E i \in 1..ci["B"] :
                /\ log["B"][i].t = "final" /\ log["B"][i].base > 1
                /\ Len(log["B"][i].recs) > log["B"][i].base - 1
                /\ \E j \in (i + 1)..ci["B"] : log["B"][j].t = "w")
\* the target is recovered after it opened; the source reopens in a new
\* epoch and takes a write
NotLostBack == ~(\E i, j \in 1..ci["A"] :
                   /\ i < j /\ log["A"][i].t = "unf" /\ log["A"][i].ep > 1
                   /\ log["A"][j].t = "w")
\* a recovered group reopens the slot by its own row and takes a write
NotReopen == ~WAfter("A", "reopen")
\* the source is recovered and loses its fence; the target still opens, on
\* the old life's report, and takes a write
NotOldReport == ~(/\ inc["A"] = 1 /\ ~Has(CL("A"), "fence", 1) /\ WAfter("B", "final"))
\* a recovered group takes part in a later move: as its source, after it
\* reopened; and as its target
Before(g, t1, t2) == \E i, j \in 1..ci[g] : i < j /\ log[g][i].t = t1 /\ log[g][j].t = t2
NotAfterSrc == ~(Before("A", "reopen", "fence") /\ WAfter("B", "final"))
NotAfterDst == ~(Before("B", "rec", "final") /\ WAfter("B", "final"))
\* the slot moves to B and back to A, and A takes a write
NotTwice == ~WAfter("A", "final")
=============================================================================
