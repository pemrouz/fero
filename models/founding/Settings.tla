---------------------------- MODULE Settings ----------------------------
(* Founding, row 1: settings taken up per group, an alter, the read-only gate.

   A resource has a home group "h" and some other groups.  The settings
   record lives in the home group's log.  An alter is one entry there.  Each
   other group follows the home log and takes a settings version up by an
   entry in its OWN log.  An alter is in force, and answered, only once
   every group has taken it up.

   The world (not counted as rules).  Every group is an abstract Raft
   group: one log, a commit index, a tail a leader change may drop.  A group
   may be down (no majority): it then takes nothing and commits nothing.
   One client holds a settings version it learned from some copy, and
   sends writes that name that version.

   Lines marked  \* @rule <ledger id or name>  hold the rules.  mutants.txt
   plants one-line mistakes on them.  A name that starts "line:" marks a
   line that has no ledger id of its own.  The "behind" answer (line
   settings-behind) holds AsMade, the property the owner dropped (V5-37):
   the model keeps both so its runs stay as they were. *)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS Data,      \* the groups beside the home group
          MaxVer,    \* alters the operator makes
          MaxW,      \* writes the client makes
          MaxCrash,  \* leader changes, over all groups
          MaxDown,   \* times a group loses its majority
          Early      \* is a write told "received" when a leader takes it?

VARIABLES log,       \* log[g]: the leader's log of group g, tail included
          ci,        \* ci[g]: how much of log[g] is committed
          up,        \* up[g]: the group has a majority
          answered,  \* the versions whose alter was answered
          cver,      \* the settings version the client holds
          wst,       \* wst[w]: what the client knows of write w
          wg,        \* wg[w]: the group write w goes to
          msgs,      \* writes in flight
          crashes, downs,
          late,      \* ghost: a write committed while a read-only alter was in force
          early      \* ghost: the writes told "received"

vars == <<log, ci, up, answered, cver, wst, wg, msgs, crashes, downs, late, early>>

Home   == "h"
Groups == {Home} \cup Data
W      == 1..MaxW

Max(S) == CHOOSE x \in S : \A y \in S : y <= x

\* A "set" entry takes a settings version up; ro says its gate is read-only.
\* A "w" entry is a write; v is the version it was judged under, cv the
\* version its sender held.
SetE(v, ro)   == [t |-> "set", v |-> v, ro |-> ro, w |-> 0, cv |-> 0]
WrE(w, v, cv) == [t |-> "w", v |-> v, ro |-> FALSE, w |-> w, cv |-> cv]

LastSet(L, n) == LET S == {i \in 1..n : L[i].t = "set"} IN IF S = {} THEN 0 ELSE Max(S)
VerAt(L, n)   == IF LastSet(L, n) = 0 THEN 0 ELSE L[LastSet(L, n)].v
RoAt(L, n)    == IF LastSet(L, n) = 0 THEN FALSE ELSE L[LastSet(L, n)].ro

\* What a follower of the home log may read of it.
HomeRead == SubSeq(log[Home], 1, ci[Home])                    \* @rule meta-catalog.5 home-committed
HomeVer  == VerAt(log[Home], ci[Home])
HomeRo(v) == \E i \in 1..ci[Home] : /\ log[Home][i].t = "set"
                                    /\ log[Home][i].v = v /\ log[Home][i].ro

\* The version a group has taken up for good, and the one at its log end.
Taken(g)    == VerAt(log[g], ci[g])
TakenEnd(g) == VerAt(log[g], Len(log[g]))

\* The place in its log a leader judges a new write at.
JudgeAt(g) == Len(log[g])                                     \* @rule writer-judging.1

Init == /\ log = [g \in Groups |-> <<>>]
        /\ ci = [g \in Groups |-> 0]
        /\ up = [g \in Groups |-> TRUE]
        /\ answered = {}
        /\ cver = 0
        /\ wst = [w \in W |-> "new"]
        /\ wg = [w \in W |-> Home]
        /\ msgs = {}
        /\ crashes = 0 /\ downs = 0
        /\ late = FALSE /\ early = {}

--------------------------------------------------------------------------
(* The operator *)

\* An alter is one entry in the home log (meta-catalog.2).
Alter(ro) ==
    /\ up[Home]
    /\ TakenEnd(Home) < MaxVer
    /\ log' = [log EXCEPT ![Home] = Append(@, SetE(TakenEnd(Home) + 1, ro))]   \* @rule meta-catalog.2
    /\ UNCHANGED <<ci, up, answered, cver, wst, wg, msgs, crashes, downs, late, early>>

\* The alter is answered once every group has taken it up, for good.
Answer(v) ==
    /\ up[Home]
    /\ v \in 1..HomeVer /\ v \notin answered
    /\ \A g \in Groups : Taken(g) >= v                        \* @rule meta-catalog.5
    /\ answered' = answered \cup {v}
    /\ UNCHANGED <<log, ci, up, cver, wst, wg, msgs, crashes, downs, late, early>>

--------------------------------------------------------------------------
(* The groups *)

\* A group takes up the newest settings version the home log has committed,
\* by an entry in its own log.
Adopt(g) ==
    /\ up[g]
    /\ LET H == HomeRead
           v == VerAt(H, Len(H))
       IN /\ TakenEnd(g) < v
          /\ log' = [log EXCEPT ![g] = Append(@, SetE(v, RoAt(H, Len(H))))]    \* @rule meta-catalog.5 own-entry
    /\ UNCHANGED <<ci, up, answered, cver, wst, wg, msgs, crashes, downs, late, early>>

\* A read-only alter is in force: it is the newest committed one, it is
\* answered, and its gate is read-only.
InForceRo == HomeVer \in answered /\ HomeRo(HomeVer)

Commit(g) ==
    /\ up[g]
    /\ ci[g] < Len(log[g])
    /\ ci' = [ci EXCEPT ![g] = @ + 1]
    /\ late' = (late \/ (InForceRo /\ log[g][ci[g] + 1].t = "w"))
    /\ UNCHANGED <<log, up, answered, cver, wst, wg, msgs, crashes, downs, early>>

\* A leader takes a write, refuses it read-only, or sends it back as
\* "behind" when the sender holds settings this group has not taken up
\* (no ledger rule: the owner dropped AsMade, V5-37).
\* It sends the read-only refusal only once the entry that set the gate has
\* committed; until then the write waits.
Take(m) ==
    /\ m \in msgs /\ up[m.g]
    /\ msgs' = msgs \ {m}
    /\ LET L == log[m.g]
           n == JudgeAt(m.g)
           a == VerAt(L, n)
       IN IF RoAt(L, n)                                       \* @rule meta-catalog.4
          THEN /\ LastSet(L, n) <= ci[m.g]                    \* @rule writer-judging.2
               /\ wst' = [wst EXCEPT ![m.w] = "ro"]
               /\ UNCHANGED <<log, early>>
          ELSE IF m.cv > a                                    \* @rule line:settings-behind
          THEN /\ wst' = [wst EXCEPT ![m.w] = "behind"]
               /\ UNCHANGED <<log, early>>
          ELSE /\ log' = [log EXCEPT ![m.g] = Append(@, WrE(m.w, a, m.cv))]
               /\ wst' = [wst EXCEPT ![m.w] = "in"]
               /\ early' = IF Early THEN early \cup {m.w} ELSE early
    /\ UNCHANGED <<ci, up, answered, cver, wg, crashes, downs, late>>

--------------------------------------------------------------------------
(* The client *)

\* Any copy hands out the settings version its group has taken up.
Learn(g) ==
    /\ up[g] /\ cver < Taken(g)
    /\ cver' = Taken(g)                                               \* @rule line:learn-committed
    /\ UNCHANGED <<log, ci, up, answered, wst, wg, msgs, crashes, downs, late, early>>

Send(w, g) ==
    /\ wst[w] = "new"
    /\ wg' = [wg EXCEPT ![w] = g]
    /\ wst' = [wst EXCEPT ![w] = "sent"]
    /\ msgs' = msgs \cup {[w |-> w, g |-> g, cv |-> cver]}            \* @rule line:send-names-version
    /\ UNCHANGED <<log, ci, up, answered, cver, crashes, downs, late, early>>

InLog(w, g) == \E i \in DOMAIN log[g] : log[g][i].t = "w" /\ log[g][i].w = w
Done(w, g)  == \E i \in 1..ci[g] : log[g][i].t = "w" /\ log[g][i].w = w

\* The client sends a write again: it was sent back as "behind", or its
\* entry was dropped with a tail.
Resend(w) ==
    /\ wst[w] \in {"behind", "in"}
    /\ ~InLog(w, wg[w])
    /\ wst' = [wst EXCEPT ![w] = "sent"]
    /\ msgs' = msgs \cup {[w |-> w, g |-> wg[w], cv |-> cver]}
    /\ UNCHANGED <<log, ci, up, answered, cver, wg, crashes, downs, late, early>>

Ack(w) ==
    /\ wst[w] = "in" /\ up[wg[w]] /\ Done(w, wg[w])                   \* @rule line:ack-committed
    /\ wst' = [wst EXCEPT ![w] = "ok"]
    /\ UNCHANGED <<log, ci, up, answered, cver, wg, msgs, crashes, downs, late, early>>

--------------------------------------------------------------------------
(* Faults *)

\* A leader change drops some of the uncommitted tail.
Crash(g) ==
    /\ crashes < MaxCrash
    /\ \E k \in ci[g]..(Len(log[g]) - 1) : log' = [log EXCEPT ![g] = SubSeq(@, 1, k)]
    /\ crashes' = crashes + 1
    /\ UNCHANGED <<ci, up, answered, cver, wst, wg, msgs, downs, late, early>>

Down(g) ==
    /\ up[g] /\ downs < MaxDown
    /\ up' = [up EXCEPT ![g] = FALSE] /\ downs' = downs + 1
    /\ UNCHANGED <<log, ci, answered, cver, wst, wg, msgs, crashes, late, early>>

Up(g) ==
    /\ ~up[g]
    /\ up' = [up EXCEPT ![g] = TRUE]
    /\ UNCHANGED <<log, ci, answered, cver, wst, wg, msgs, crashes, downs, late, early>>

\* The steps of the design itself: no fault, no operator.
Calm == \/ \E g \in Groups : Commit(g) \/ Learn(g)
        \/ \E g \in Data : Adopt(g)
        \/ \E v \in 1..MaxVer : Answer(v)
        \/ \E m \in msgs : Take(m)
        \/ \E w \in W : Resend(w) \/ Ack(w) \/ (\E g \in Groups : Send(w, g))

\* The operator's alters, and the faults.
Rough == \/ \E ro \in BOOLEAN : Alter(ro)
         \/ \E g \in Groups : Crash(g) \/ Down(g) \/ Up(g)

Next == Calm \/ Rough

Spec == Init /\ [][Next]_vars

--------------------------------------------------------------------------
(* Properties, on committed state *)

Committed(g) == 1..ci[g]

\* Every group takes up only settings the home log committed, as committed.
Same == \A g \in Data : \A i \in Committed(g) :
          log[g][i].t = "set" =>
            /\ log[g][i].v <= HomeVer
            /\ log[g][i].ro = HomeRo(log[g][i].v)

\* A write is judged under the settings its group had taken up before it.
JudgeOrder == \A g \in Groups : \A i \in Committed(g) :
                log[g][i].t = "w" => log[g][i].v = VerAt(log[g], i)

\* The gate, per group: no write after a read-only version in that log.
GateGroup == \A g \in Groups : \A i \in Committed(g) :
               log[g][i].t = "w" => ~RoAt(log[g], i)

\* The gate, for the resource: once a read-only alter is answered, no write
\* commits in any group until a later alter commits.
GateAll == ~late

\* An answered alter has been taken up by every group, for good.
InForce == \A v \in answered : \A g \in Groups : Taken(g) >= v

\* No write is judged under settings older than the ones its sender held.
\* The owner dropped this property (V5-37); it is kept as it was checked.
AsMade == \A g \in Groups : \A i \in Committed(g) :
            log[g][i].t = "w" => log[g][i].cv <= log[g][i].v

\* "ok" is told only for a committed write.
Told == \A w \in W : wst[w] = "ok" => Done(w, wg[w])

\* "read-only" is told only under a gate that committed in that group.
RoTrue == \A w \in W : wst[w] = "ro" =>
            \E i \in Committed(wg[w]) : log[wg[w]][i].t = "set" /\ log[wg[w]][i].ro

\* No stuck state: with every group up, when no step of the design can
\* run, every committed alter is answered and no write is left hanging.
NoStuck == ((\A g \in Groups : up[g]) /\ ~ENABLED Calm) =>
             /\ answered = 1..HomeVer
             /\ \A w \in W : wst[w] \in {"ok", "ro"}

\* For the "always can finish" check (see Live.tla and agef.py).
Goal   == answered = 1..HomeVer /\ \A w \in W : wst[w] \in {"ok", "ro"}
Judged == \A g \in Groups : up[g]

Shape == /\ \A g \in Groups : ci[g] <= Len(log[g])
         /\ cver <= HomeVer

\* A probe, not a property of the first build: an early answer is never
\* followed by a final refusal (the study's ruling on answer stages).
EarlyKept == \A w \in early : wst[w] # "ro"

\* Reach checks: each says "the goal is never reached", so TLC must find
\* it violated.
NotDone    == ~(answered = 1..MaxVer /\ \A w \in W : wst[w] = "ok")
NotRefused == ~(\E w \in W : wst[w] = "ro" /\ answered = 1..MaxVer)
NotBehind  == ~(\E w \in W : wst[w] = "behind")
=============================================================================
