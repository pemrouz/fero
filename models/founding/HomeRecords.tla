---------------------------- MODULE HomeRecords ----------------------------
(* Founding, row 2: a client that first reaches another group's copy, with
   the home group down.

   The home records are the slot table and the group records.  They live in
   the home group's log.  Here every copy of every group keeps them: a
   group's leader follows the home log and writes what it reads into its
   own group's log, and a follower gets them with that log, later.  Any copy
   hands a client the records it has, maybe old.  A group that does not
   hold the slot answers "moved" and names the owner it knows.

   The world (not counted as rules).  One slot.  A home group "h" and the
   groups of Data.  Each group has a leader copy "L" and a follower copy
   "F"; the follower is behind until it catches up.  A slot move is one
   step here (its own model is another stage): the old group's log says
   "moved to b", the new group's log says "open", the home table gets the
   row.  A group may go down: then none of its copies answers.  One client
   with one write.  The directory may hand the client any copy, a dead one
   or a server of another resource that took a dead address ("x").

   Lines marked  \* @rule <ledger id>  hold the rules. *)
EXTENDS Naturals, FiniteSets

CONSTANTS Data,       \* the groups beside the home group
          StartG,     \* the group that holds the slot at founding
          MaxMove,    \* slot moves
          MayDown,    \* the groups that may go down
          MaxDown,    \* how many times
          HomeBack,   \* may the home group come back?
          Foreign,    \* is there a server of another resource?
          FwdHops     \* hops one forwarding server makes for one write

VARIABLES up,     \* up[g]: the group's copies answer
          gl,     \* gl[g]: what g's own committed log says of the slot
          tab,    \* the slot's row in the home log
          lhr,    \* lhr[g]: the home row as g's own log holds it
          fol,    \* fol[g]: what g's follower has applied: [own, hr]
          moves, downs,
          crow,   \* the client's row for the slot
          link,   \* the copy the client is linked to
          fail,   \* the client saw a failure since it linked
          wst,    \* the write: "idle", "sent", "ok"
          msg,    \* the write or its answer, in flight
          comm,   \* ghost: the group the write committed in
          wrong,  \* ghost: it committed in a group that did not hold the slot
          taken,  \* ghost: how many rows the client took
          first,  \* ghost: the first copy the client linked to
          hdown,  \* ghost: the home group was down at that first link
          asked,  \* ghost: the rows the client wrote by and was told "moved"
          again   \* ghost: the client wrote by such a row again

vars == <<up, gl, tab, lhr, fol, moves, downs, crow, link, fail, wst, msg,
          comm, wrong, taken, first, hdown, asked, again>>

Home   == "h"
Groups == {Home} \cup Data
X      == <<"x", "L">>
NoC    == <<"none", "L">>
Copies == (Groups \X {"L", "F"}) \cup (IF Foreign THEN {X} ELSE {})

NoRow        == [g |-> "none", e |-> 0]
Higher(a, b) == IF a.e >= b.e THEN a ELSE b                           \* @rule line:higher
None         == [st |-> "none", to |-> "none", e |-> 0]

\* What a group's own log says, as a row: where the slot is, at which epoch.
OwnRow(own, g) == IF own.st = "open" THEN [g |-> g, e |-> own.e]
                  ELSE IF own.st = "moved" THEN [g |-> own.to, e |-> own.e]
                  ELSE NoRow

Lhr(g) == IF g = Home THEN tab ELSE lhr[g]

\* The newest row a copy knows: from its own group's log or from its copy
\* of the home records, whichever is newer.
Best(c) == IF c[2] = "L"
           THEN Higher(OwnRow(gl[c[1]], c[1]), Lhr(c[1]))               \* @rule home-records.1
           ELSE Higher(OwnRow(fol[c[1]].own, c[1]), fol[c[1]].hr)       \* @rule home-records.2

\* A write straight from the client has no forwarding copy (NoC).
UpC(c) == IF c \in {X, NoC} THEN TRUE ELSE up[c[1]]

\* A client keeps a row only if it is newer than the one it holds.
Newer(new, old)   == new.e > old.e                                      \* @rule slot-table.6
TakeRow(old, new) == IF Newer(new, old) THEN new ELSE old
Took(old, new)    == IF TakeRow(old, new) # old THEN 1 ELSE 0

\* The resource check: the server names this project and resource.
Check(c) == c # X                                                       \* @rule soft-directory.8

NoMsg == [k |-> "none", g |-> "none", c |-> NoC, row |-> NoRow, hops |-> 0]
Msg(k, g, c, row, hops) == [k |-> k, g |-> g, c |-> c, row |-> row, hops |-> hops]

Init == /\ up = [g \in Groups |-> TRUE]
        /\ gl = [g \in Groups |-> IF g = StartG THEN [st |-> "open", to |-> "none", e |-> 1] ELSE None]
        /\ tab = [g |-> StartG, e |-> 1]
        /\ lhr = [g \in Groups |-> [g |-> StartG, e |-> 1]]
        /\ fol = [g \in Groups |-> [own |-> IF g = StartG THEN [st |-> "open", to |-> "none", e |-> 1] ELSE None,
                                    hr |-> [g |-> StartG, e |-> 1]]]
        /\ moves = 0 /\ downs = 0
        /\ crow = NoRow /\ link = NoC /\ fail = FALSE
        /\ wst = "idle" /\ msg = NoMsg
        /\ comm = "none" /\ wrong = FALSE /\ taken = 0 /\ first = NoC /\ hdown = FALSE
        /\ asked = {} /\ again = FALSE

--------------------------------------------------------------------------
(* The world *)

Move(a, b) ==
    /\ moves < MaxMove /\ a # b
    /\ up[a] /\ up[b] /\ up[Home]
    /\ gl[a].st = "open"
    /\ LET e == gl[a].e + 1
       IN /\ gl' = [gl EXCEPT ![a] = [st |-> "moved", to |-> b, e |-> e],
                              ![b] = [st |-> "open", to |-> "none", e |-> e]]
          /\ tab' = [g |-> b, e |-> e]
    /\ moves' = moves + 1
    /\ UNCHANGED <<up, lhr, fol, downs, crow, link, fail, wst, msg, comm, wrong, taken, first, hdown, asked, again>>

\* A group's leader follows the home log and writes the row into its own log.
PassDown(g) ==
    /\ g # Home /\ up[g] /\ up[Home]
    /\ lhr[g].e < tab.e
    /\ lhr' = [lhr EXCEPT ![g] = tab]
    /\ UNCHANGED <<up, gl, tab, fol, moves, downs, crow, link, fail, wst, msg, comm, wrong, taken, first, hdown, asked, again>>

\* A follower catches up with its group's log: the slot's state and the
\* home records come together.
Catch(g) ==
    /\ up[g]
    /\ fol[g] # [own |-> gl[g], hr |-> Lhr(g)]
    /\ fol' = [fol EXCEPT ![g] = [own |-> gl[g], hr |-> Lhr(g)]]
    /\ UNCHANGED <<up, gl, tab, lhr, moves, downs, crow, link, fail, wst, msg, comm, wrong, taken, first, hdown, asked, again>>

Down(g) ==
    /\ g \in MayDown /\ up[g] /\ downs < MaxDown
    /\ up' = [up EXCEPT ![g] = FALSE] /\ downs' = downs + 1
    /\ UNCHANGED <<gl, tab, lhr, fol, moves, crow, link, fail, wst, msg, comm, wrong, taken, first, hdown, asked, again>>

Up(g) ==
    /\ ~up[g] /\ (g # Home \/ HomeBack)
    /\ up' = [up EXCEPT ![g] = TRUE]
    /\ UNCHANGED <<gl, tab, lhr, fol, moves, downs, crow, link, fail, wst, msg, comm, wrong, taken, first, hdown, asked, again>>

--------------------------------------------------------------------------
(* The client *)

\* The client links to a copy the directory named, checks it, and takes
\* the home records that copy has.
Dial(c) ==
    /\ link = NoC /\ wst = "idle"
    /\ UpC(c) /\ Check(c)
    /\ link' = c /\ fail' = FALSE
    /\ LET r == IF c = X THEN NoRow ELSE Best(c)
       IN crow' = TakeRow(crow, r) /\ taken' = taken + Took(crow, r)  \* @rule line:dial-newer
    /\ first' = IF first = NoC THEN c ELSE first
    /\ hdown' = IF first = NoC THEN ~up[Home] ELSE hdown
    /\ UNCHANGED <<up, gl, tab, lhr, fol, moves, downs, wst, msg, comm, wrong, asked, again>>

\* Once the member it knew has failed (no answer, or its copy says the
\* group it names is down), the client asks the directory again
\* (soft-directory.9).  A "moved" or a "retry" is not a failure.
Unlink ==
    /\ link # NoC /\ wst = "idle"
    /\ fail \/ ~UpC(link)                                             \* @rule soft-directory.9
    /\ link' = NoC
    /\ UNCHANGED <<up, gl, tab, lhr, fol, moves, downs, crow, fail, wst, msg, comm, wrong, taken, first, hdown, asked, again>>

\* The client sends the write to the leader of the group its row names.
SendDirect ==
    /\ wst = "idle" /\ link # NoC /\ link # X
    /\ crow.g \in Groups
    /\ msg' = Msg("lead", crow.g, NoC, NoRow, 0)                        \* @rule route-smart.1
    /\ wst' = "sent"
    /\ again' = (again \/ crow \in asked)
    /\ UNCHANGED <<up, gl, tab, lhr, fol, moves, downs, crow, link, fail, comm, wrong, taken, first, hdown, asked>>

\* Or it hands the write to the copy it is linked to, which forwards it.
SendVia ==
    /\ wst = "idle" /\ link # NoC
    /\ msg' = Msg("copy", "none", link, NoRow, 0)
    /\ wst' = "sent"
    /\ UNCHANGED <<up, gl, tab, lhr, fol, moves, downs, crow, link, fail, comm, wrong, taken, first, hdown, asked, again>>

\* A "moved" answer reaches the client: it takes the row and sends again.
ClientMoved ==
    /\ msg.k = "cmoved" \/ (msg.k = "moved" /\ msg.c = NoC)
    /\ crow' = TakeRow(crow, msg.row) /\ taken' = taken + Took(crow, msg.row) \* @rule line:moved-newer
    /\ wst' = "idle" /\ msg' = NoMsg
    /\ fail' = (fail \/ (msg.k = "cmoved" /\ msg.g = "down"))
    /\ asked' = IF msg.k = "moved" THEN asked \cup {crow} ELSE asked
    /\ UNCHANGED <<up, gl, tab, lhr, fol, moves, downs, link, comm, wrong, first, hdown, again>>

\* No answer: the group the client wrote to is down, or its forwarder is.
\* The answer is never final: the client tries again (route-smart.2).
Timeout ==
    /\ \/ msg.k = "lead" /\ msg.c = NoC /\ ~up[msg.g]
       \/ msg.k \in {"copy", "lead", "moved"} /\ msg.c # NoC /\ ~UpC(msg.c)
    /\ wst' = "idle" /\ msg' = NoMsg /\ fail' = TRUE                    \* @rule route-smart.2
    /\ UNCHANGED <<up, gl, tab, lhr, fol, moves, downs, crow, link, comm, wrong, taken, first, hdown, asked, again>>

--------------------------------------------------------------------------
(* The servers *)

\* A leader takes the write only while its own committed log holds the
\* slot open.
LeadTake ==
    /\ msg.k = "lead" /\ up[msg.g] /\ UpC(msg.c)
    /\ gl[msg.g].st = "open"                                            \* @rule slot-table.1
    /\ comm' = msg.g
    /\ wrong' = (wrong \/ gl[msg.g].st # "open")
    /\ wst' = "ok" /\ msg' = NoMsg
    /\ UNCHANGED <<up, gl, tab, lhr, fol, moves, downs, crow, link, fail, taken, first, hdown, asked, again>>

\* Otherwise it answers "moved" with the newest owner it knows, or "retry"
\* (a "moved" with no row) when it knows none.
LeadMoved ==
    /\ msg.k = "lead" /\ up[msg.g] /\ UpC(msg.c)
    /\ gl[msg.g].st # "open"
    /\ LET r == Best(<<msg.g, "L">>)                                  \* @rule line:moved-own-log
       IN msg' = Msg("moved", msg.g, msg.c, IF r.g = msg.g THEN NoRow ELSE r, msg.hops)   \* @rule slot-table.3
    /\ UNCHANGED <<up, gl, tab, lhr, fol, moves, downs, crow, link, fail, wst, comm, wrong, taken, first, hdown, asked, again>>

\* A copy forwards a write to the group its newest row names.
CopyFwd ==
    /\ msg.k = "copy" /\ msg.c # X /\ UpC(msg.c)
    /\ LET r == Best(msg.c)
       IN msg' = IF r.g \in Groups THEN Msg("lead", r.g, msg.c, NoRow, 1)
                 ELSE Msg("cmoved", "retry", NoC, NoRow, 0)
    /\ UNCHANGED <<up, gl, tab, lhr, fol, moves, downs, crow, link, fail, wst, comm, wrong, taken, first, hdown, asked, again>>

\* A copy that cannot forward (the group it wrote to is down) refuses at
\* once with a redirect: the newest row it has.
FwdRefuse ==
    /\ msg.k = "lead" /\ msg.c # NoC /\ UpC(msg.c) /\ ~up[msg.g]
    /\ msg' = Msg("cmoved", "down", NoC, Best(msg.c), 0)                \* @rule route-forward.1
    /\ UNCHANGED <<up, gl, tab, lhr, fol, moves, downs, crow, link, fail, wst, comm, wrong, taken, first, hdown, asked, again>>

\* On "moved", a forwarding copy forwards to the owner the answer names,
\* or passes the answer to the client.
FwdMoved ==
    /\ msg.k = "moved" /\ msg.c # NoC /\ UpC(msg.c)
    /\ \/ /\ msg.hops < FwdHops /\ msg.row.g \in Groups
          /\ msg' = Msg("lead", msg.row.g, msg.c, NoRow, msg.hops + 1)  \* @rule route-forward.2
       \/ msg' = Msg("cmoved", "moved", NoC, msg.row, 0)              \* @rule route-forward.2 pass
    /\ UNCHANGED <<up, gl, tab, lhr, fol, moves, downs, crow, link, fail, wst, comm, wrong, taken, first, hdown, asked, again>>

\* The other resource's server takes the write as its own (reached only
\* when the resource check is planted out).
XTake ==
    /\ msg.k = "copy" /\ msg.c = X
    /\ wst' = "ok" /\ msg' = NoMsg
    /\ UNCHANGED <<up, gl, tab, lhr, fol, moves, downs, crow, link, fail, comm, wrong, taken, first, hdown, asked, again>>

\* The steps of the design itself: no fault, no move.
Calm == \/ \E c \in Copies : Dial(c)
        \/ Unlink \/ SendDirect \/ SendVia \/ ClientMoved \/ Timeout
        \/ LeadTake \/ LeadMoved \/ CopyFwd \/ FwdRefuse \/ FwdMoved \/ XTake
        \/ \E g \in Groups : PassDown(g) \/ Catch(g)

\* Moves and faults.
Rough == \/ \E a, b \in Groups : Move(a, b)
         \/ \E g \in Groups : Down(g) \/ Up(g)

Next == Calm \/ Rough

Spec == Init /\ [][Next]_vars

--------------------------------------------------------------------------
(* Properties *)

Owner == CHOOSE g \in Groups : gl[g].st = "open"

\* The world keeps the slot open in one group.
OneOpen == Cardinality({g \in Groups : gl[g].st = "open"}) = 1

\* The write commits only in the group that holds the slot.
Right == ~wrong

\* "ok" is told only for a write that committed in this resource.
TrueOk == wst = "ok" => comm \in Groups

\* The client follows rows forward only: it takes at most one row per epoch.
Forward == taken <= 1 + moves

\* A "moved" answer always moves the client on: it never writes again by
\* a row whose group told it "moved".
NoRepeat == ~again

\* No copy holds a row newer than the truth.
NoFuture == \A c \in Copies \ {X} : Best(c).e <= gl[Owner].e

\* No stuck state: while the owner's group is up, when no step of the
\* design can run, the write has committed.
NoStuck == (up[Owner] /\ ~ENABLED Calm) => wst = "ok"

\* For the "always can finish" check (see Live.tla and agef.py): from every
\* state where the owner's group is up, calm steps can commit the write.
Goal   == wst = "ok"
Judged == up[Owner]

\* Reach checks ("never reached": TLC must find each violated).
\* The home group was down before the client's first link, that link was to
\* another group's copy, and the write committed.
NotFound == ~(wst = "ok" /\ hdown /\ first[1] # Home)
\* The same, where that first copy is a follower and the slot has moved twice.
NotFoundFar == ~(wst = "ok" /\ hdown /\ first[1] # Home /\ first[2] = "F" /\ moves = 2 /\ taken >= 2)
\* The same, where that first copy's group is not the one that holds the slot.
NotFoundOther == ~(wst = "ok" /\ hdown /\ first[1] \notin {Home, comm})
=============================================================================
