---------------------------- MODULE Selection ----------------------------
(* Founding, row 4: one selection over a whole resource that has two
   groups, a slot move each way, and one group down.

   A selection over a whole resource is one subscription per group.  Each
   group answers with a picture of the slots it holds, each at its own
   position, then sends each later record.  Positions are per slot and go
   on across a move.  At a move the old group ends the slot with END at
   the fence and names the new group; the client then asks the new group
   for that slot.  The client keeps one store, with one cursor per slot.

   The world (not counted as rules).  Groups "A" and "B".  Slot "s1" starts
   in A and "s2" in B.  A slot's log is a counter: record n makes the
   slot's value n, so a record taken twice or skipped shows.  Only
   committed records exist here (lost tails are another model's).  A move
   is a fence at the old group and then an open at the new one.  A slot
   moves once, to the other group; with Back it may then move back, once
   the group it returns to has ended its old stream of the slot.  A group
   may go down: its link to the client drops, and it sends, takes and
   opens nothing.  A link may drop alone.  Each link carries frames in
   order, at most QMax at a time.

   Lines marked  \* @rule <ledger id or name>  hold the rules. *)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS MaxRec,       \* records per slot
          MovesOf,      \* the slots that may move (each once, to the other group)
          MaxDown,      \* times a group goes down
          MaxDrop,      \* times a link drops alone
          QMax,         \* frames a link holds
          ReadyBySlots, \* is "ready" judged per slot, not only per group?
          Back          \* may a slot that moved move back to its first group?

VARIABLES up, hold, pos, moved, fenceAt, from,
          sub,     \* sub[g]: the server holds the client's subscription
          strm,    \* strm[g]: the slots it streams on it
          sent,    \* sent[g][s]: the last position it sent
          q,       \* q[g]: frames on the way to the client
          req,     \* asks on the way to the servers
          cs,      \* cs[g]: the client's subscription: "none", "asked", "live"
          has,     \* has[s]: the client holds a picture of the slot
          cur,     \* cur[s]: the client's cursor for the slot
          view,    \* view[s]: the client's value for the slot
          src,     \* src[s]: the group the client takes the slot from
          ask,     \* ask[s]: the group the client must ask for the slot
          downs, drops,
          back     \* ghost: a cursor went back

vars == <<up, hold, pos, moved, fenceAt, from, sub, strm, sent, q, req,
          cs, has, cur, view, src, ask, downs, drops, back>>

Groups == {"A", "B"}
Slots  == {"s1", "s2"}
Start(s) == IF s = "s1" THEN "A" ELSE "B"
Other(g) == IF g = "A" THEN "B" ELSE "A"
NoP == MaxRec + 1          \* "this picture does not cover the slot"

Frame(t, s, n, to, at, gone) == [t |-> t, s |-> s, n |-> n, to |-> to, at |-> at, gone |-> gone]
NoAt   == [s \in Slots |-> NoP]
NoGone == [s \in Slots |-> "none"]

\* fenceAt[g][s] is the position at which g handed slot s off, or NoP while
\* g has not handed it off or holds it again.
\* The slots a group handed off, with the group each went to.
Gone(g) == [s \in Slots |-> IF fenceAt[g][s] # NoP THEN Other(g) ELSE "none"]   \* @rule subscribe.39

Init == /\ up = [g \in Groups |-> TRUE]
        /\ hold = [s \in Slots |-> Start(s)]
        /\ pos = [s \in Slots |-> 0]
        /\ moved = [s \in Slots |-> "no"]
        /\ fenceAt = [g \in Groups |-> [s \in Slots |-> NoP]]
        /\ from = [s \in Slots |-> Start(s)]
        /\ sub = [g \in Groups |-> FALSE]
        /\ strm = [g \in Groups |-> {}]
        /\ sent = [g \in Groups |-> [s \in Slots |-> 0]]
        /\ q = [g \in Groups |-> <<>>]
        /\ req = {}
        /\ cs = [g \in Groups |-> "none"]
        /\ has = [s \in Slots |-> FALSE]
        /\ cur = [s \in Slots |-> 0]
        /\ view = [s \in Slots |-> 0]
        /\ src = [s \in Slots |-> "none"]
        /\ ask = [s \in Slots |-> "none"]
        /\ downs = 0 /\ drops = 0 /\ back = FALSE

--------------------------------------------------------------------------
(* The world: writes and moves *)

WriteRec(s) ==
    /\ hold[s] # "none" /\ up[hold[s]]
    /\ pos[s] < MaxRec
    /\ pos' = [pos EXCEPT ![s] = @ + 1]
    /\ UNCHANGED <<up, hold, moved, fenceAt, from, sub, strm, sent, q, req, cs, has, cur, view, src, ask, downs, drops, back>>

Fence(s) ==
    /\ s \in MovesOf
    /\ moved[s] = "no" \/ (Back /\ moved[s] = "done" /\ hold[s] # Start(s))
    /\ up[hold[s]]
    /\ moved' = [moved EXCEPT ![s] = "fenced"]
    /\ fenceAt' = [fenceAt EXCEPT ![hold[s]][s] = pos[s]]
    /\ from' = [from EXCEPT ![s] = hold[s]]
    /\ hold' = [hold EXCEPT ![s] = "none"]
    /\ UNCHANGED <<up, pos, sub, strm, sent, q, req, cs, has, cur, view, src, ask, downs, drops, back>>

OpenAt(s) ==
    /\ moved[s] = "fenced"
    /\ up[from[s]] /\ up[Other(from[s])]
    /\ s \notin strm[Other(from[s])]
    /\ moved' = [moved EXCEPT ![s] = "done"]
    /\ hold' = [hold EXCEPT ![s] = Other(from[s])]
    /\ fenceAt' = [fenceAt EXCEPT ![Other(from[s])][s] = NoP]
    /\ UNCHANGED <<up, pos, from, sub, strm, sent, q, req, cs, has, cur, view, src, ask, downs, drops, back>>

--------------------------------------------------------------------------
(* The servers *)

Room(g) == Len(q[g]) < QMax

\* A group answers a subscription with a picture of the slots it holds,
\* each at its position, and the slots it handed off.
ServeSub(g) ==
    /\ up[g] /\ [t |-> "sub", g |-> g, s |-> "none"] \in req /\ Room(g)
    /\ req' = req \ {[t |-> "sub", g |-> g, s |-> "none"]}
    /\ sub' = [sub EXCEPT ![g] = TRUE]
    /\ strm' = [strm EXCEPT ![g] = {s \in Slots : hold[s] = g}]                        \* @rule subscribe.1
    /\ sent' = [sent EXCEPT ![g] = [s \in Slots |-> IF hold[s] = g THEN pos[s] ELSE 0]]
    /\ q' = [q EXCEPT ![g] = Append(@, Frame("pic", "none", 0, "none",
                 [s \in Slots |-> IF hold[s] = g THEN pos[s] ELSE NoP], Gone(g)))]     \* @rule subscribe.3
    /\ UNCHANGED <<up, hold, pos, moved, fenceAt, from, cs, has, cur, view, src, ask, downs, drops, back>>

\* The last position a group may send for a slot: the slot's position
\* while it holds it, the fence once it handed it off,
\* nothing (0) for a slot it never held.
Last(g, s) == IF hold[s] = g THEN pos[s] ELSE IF fenceAt[g][s] # NoP THEN fenceAt[g][s] ELSE 0

\* A group answers an ask for one slot with a picture of that slot, once
\* it holds the slot open.  Until then the ask waits (slot-move.9).
ServeSlot(g, s) ==
    /\ up[g] /\ sub[g] /\ [t |-> "slot", g |-> g, s |-> s] \in req /\ Room(g)
    /\ hold[s] = g                                                                     \* @rule slot-move.9
    /\ req' = req \ {[t |-> "slot", g |-> g, s |-> s]}
    /\ strm' = [strm EXCEPT ![g] = @ \cup {s}]
    /\ sent' = [sent EXCEPT ![g][s] = Last(g, s)]   \* @rule line:spic-sent
    /\ q' = [q EXCEPT ![g] = Append(@, Frame("spic", s, Last(g, s), "none", NoAt, NoGone))]   \* @rule line:spic-position
    /\ UNCHANGED <<up, hold, pos, moved, fenceAt, from, sub, cs, has, cur, view, src, ask, downs, drops, back>>

\* An ask for a slot the group has handed off does not wait: the group
\* answers END and names the group the slot went to.
ServeGone(g, s) ==
    /\ up[g] /\ sub[g] /\ [t |-> "slot", g |-> g, s |-> s] \in req /\ Room(g)
    /\ fenceAt[g][s] # NoP                                                             \* @rule subscribe.40
    /\ req' = req \ {[t |-> "slot", g |-> g, s |-> s]}
    /\ q' = [q EXCEPT ![g] = Append(@, Frame("end", s, fenceAt[g][s], Other(g), NoAt, NoGone))]
    /\ UNCHANGED <<up, hold, pos, moved, fenceAt, from, sub, strm, sent, cs, has, cur, view, src, ask, downs, drops, back>>

SendRec(g, s) ==
    /\ up[g] /\ sub[g] /\ s \in strm[g] /\ Room(g)
    /\ sent[g][s] < Last(g, s)                                                        \* @rule subscribe.5
    /\ q' = [q EXCEPT ![g] = Append(@, Frame("rec", s, sent[g][s] + 1, "none", NoAt, NoGone))]   \* @rule subscribe.6
    /\ sent' = [sent EXCEPT ![g][s] = @ + 1]
    /\ UNCHANGED <<up, hold, pos, moved, fenceAt, from, sub, strm, req, cs, has, cur, view, src, ask, downs, drops, back>>

\* At a move the old group ends the slot with END at the fence, after every
\* record below it, and names the new group.
SendEnd(g, s) ==
    /\ up[g] /\ sub[g] /\ s \in strm[g] /\ Room(g)
    /\ fenceAt[g][s] # NoP
    /\ sent[g][s] = fenceAt[g][s]                                                         \* @rule subscribe.29 at-fence
    /\ q' = [q EXCEPT ![g] = Append(@, Frame("end", s, fenceAt[g][s], Other(g), NoAt, NoGone))]   \* @rule subscribe.29 end
    /\ strm' = [strm EXCEPT ![g] = @ \ {s}]
    /\ UNCHANGED <<up, hold, pos, moved, fenceAt, from, sub, sent, req, cs, has, cur, view, src, ask, downs, drops, back>>

--------------------------------------------------------------------------
(* The client *)

\* One subscription per group.
Sub(g) ==
    /\ cs[g] = "none"
    /\ cs' = [cs EXCEPT ![g] = "asked"]
    /\ req' = req \cup {[t |-> "sub", g |-> g, s |-> "none"]}                          \* @rule selection.1 per-group
    /\ UNCHANGED <<up, hold, pos, moved, fenceAt, from, sub, strm, sent, q, has, cur, view, src, ask, downs, drops, back>>

\* The client asks the new group for a slot the old group ended.
AskSlot(s) ==
    /\ ask[s] # "none" /\ cs[ask[s]] = "live"
    /\ [t |-> "slot", g |-> ask[s], s |-> s] \notin req
    /\ req' = req \cup {[t |-> "slot", g |-> ask[s], s |-> s]}                         \* @rule subscribe.29 again
    /\ UNCHANGED <<up, hold, pos, moved, fenceAt, from, sub, strm, sent, q, cs, has, cur, view, src, ask, downs, drops, back>>

\* A picture of a slot is taken only at or past the client's cursor for it.
TakesPic(s, n) == n # NoP /\ (~has[s] \/ n >= cur[s])                                  \* @rule subscribe.38
\* A record is taken only if it is the next one for its slot.
TakesRec(s, n) == has[s] /\ n = cur[s] + 1                                             \* @rule subscribe.14

\* A slot the group says it handed off: the client turns to the new group,
\* unless it already takes the slot from there.
Turn(g, s, to) == to # "none" /\ src[s] \in {g, "none"}                                \* @rule subscribe.39

Recv(g) ==
    /\ q[g] # <<>>
    /\ q' = [q EXCEPT ![g] = Tail(@)]
    /\ LET f == Head(q[g]) IN
       CASE f.t = "pic" ->
              /\ cs' = [cs EXCEPT ![g] = "live"]
              /\ has' = [s \in Slots |-> has[s] \/ TakesPic(s, f.at[s])]
              /\ cur' = [s \in Slots |-> IF TakesPic(s, f.at[s]) THEN f.at[s] ELSE cur[s]]     \* @rule subscribe.13
              /\ view' = [s \in Slots |-> IF TakesPic(s, f.at[s]) THEN f.at[s] ELSE view[s]]   \* @rule subscribe.12
              /\ src' = [s \in Slots |-> IF TakesPic(s, f.at[s]) THEN g
                                         ELSE IF Turn(g, s, f.gone[s]) THEN "none" ELSE src[s]]
              /\ ask' = [s \in Slots |-> IF TakesPic(s, f.at[s]) THEN "none"
                                         ELSE IF Turn(g, s, f.gone[s]) THEN f.gone[s] ELSE ask[s]]
              /\ back' = (back \/ \E s \in Slots : TakesPic(s, f.at[s]) /\ has[s] /\ f.at[s] < cur[s])
         [] f.t = "spic" ->
              /\ has' = [has EXCEPT ![f.s] = @ \/ TakesPic(f.s, f.n)]
              /\ cur' = [cur EXCEPT ![f.s] = IF TakesPic(f.s, f.n) THEN f.n ELSE @]
              /\ view' = [view EXCEPT ![f.s] = IF TakesPic(f.s, f.n) THEN f.n ELSE @]
              /\ src' = [src EXCEPT ![f.s] = g]   \* @rule line:spic-src
              /\ ask' = [ask EXCEPT ![f.s] = IF @ = g THEN "none" ELSE @]
              /\ back' = (back \/ (TakesPic(f.s, f.n) /\ has[f.s] /\ f.n < cur[f.s]))
              /\ UNCHANGED cs
         [] f.t = "rec" ->
              /\ view' = [view EXCEPT ![f.s] = IF TakesRec(f.s, f.n) THEN @ + 1 ELSE @]        \* @rule subscribe.15
              /\ cur' = [cur EXCEPT ![f.s] = IF TakesRec(f.s, f.n) THEN f.n ELSE @]            \* @rule subscribe.16
              /\ UNCHANGED <<cs, has, src, ask, back>>
         [] f.t = "end" ->
              /\ src' = [src EXCEPT ![f.s] = IF @ = g THEN "none" ELSE @]   \* @rule line:end-src
              /\ ask' = [ask EXCEPT ![f.s] = IF src[f.s] = g \/ @ = g THEN f.to ELSE @]       \* @rule subscribe.29 turn
              /\ UNCHANGED <<cs, has, cur, view, back>>
    /\ UNCHANGED <<up, hold, pos, moved, fenceAt, from, sub, strm, sent, req, downs, drops>>

\* The selection is ready when every group's picture has come and every
\* slot is covered.
Ready == /\ \A g \in Groups : cs[g] = "live"                                           \* @rule selection.1 ready
         /\ ReadyBySlots => \A s \in Slots : has[s]                                    \* @rule selection.1

--------------------------------------------------------------------------
(* Faults *)

Cut(g) == /\ q' = [q EXCEPT ![g] = <<>>]
          /\ sub' = [sub EXCEPT ![g] = FALSE]
          /\ strm' = [strm EXCEPT ![g] = {}]
          /\ cs' = [cs EXCEPT ![g] = "none"]
          /\ req' = {r \in req : r.g # g}

Drop(g) ==
    /\ drops < MaxDrop /\ cs[g] # "none"
    /\ Cut(g) /\ drops' = drops + 1
    /\ UNCHANGED <<up, hold, pos, moved, fenceAt, from, sent, has, cur, view, src, ask, downs, back>>

Down(g) ==
    /\ up[g] /\ downs < MaxDown
    /\ up' = [up EXCEPT ![g] = FALSE]
    /\ Cut(g) /\ downs' = downs + 1
    /\ UNCHANGED <<hold, pos, moved, fenceAt, from, sent, has, cur, view, src, ask, drops, back>>

Up(g) ==
    /\ ~up[g]
    /\ up' = [up EXCEPT ![g] = TRUE]
    /\ UNCHANGED <<hold, pos, moved, fenceAt, from, sub, strm, sent, q, req, cs, has, cur, view, src, ask, downs, drops, back>>

\* The steps of the design itself: no fault, no new write, no new move.
Calm == \/ \E g \in Groups : Sub(g) \/ Recv(g) \/ ServeSub(g)
        \/ \E s \in Slots : AskSlot(s) \/ OpenAt(s)
        \/ \E g \in Groups, s \in Slots : ServeSlot(g, s) \/ ServeGone(g, s) \/ SendRec(g, s) \/ SendEnd(g, s)

\* New writes, new moves and faults.
Rough == \/ \E s \in Slots : WriteRec(s) \/ Fence(s)
         \/ \E g \in Groups : Drop(g) \/ Down(g) \/ Up(g)

Next == Calm \/ Rough

Spec == Init /\ [][Next]_vars

--------------------------------------------------------------------------
(* Properties *)

\* What the client shows for a slot is that slot's committed log at the
\* client's cursor: no record twice, none skipped, nothing from the future.
Exact == \A s \in Slots : has[s] => (view[s] = cur[s] /\ cur[s] <= pos[s])

\* A cursor never goes back.
NoBack == ~back

\* A ready selection covers every slot: it never answers from some groups
\* alone, and no slot falls between two pictures.
Whole == Ready => \A s \in Slots : has[s]

\* While a group is down the selection is not ready: a read over every
\* row waits (selection.6).
Waits == Ready => \A g \in Groups : up[g]

\* For the "always can finish" check (see Live.tla and agef.py).
Goal   == Ready /\ \A s \in Slots : has[s] /\ cur[s] = pos[s]
Judged == \A g \in Groups : up[g]

\* No stuck state: with both groups up, when no step of the design can
\* run, the selection is ready and level with every slot.
NoStuck == ((\A g \in Groups : up[g]) /\ ~ENABLED Calm) =>
             (Ready /\ \A s \in Slots : has[s] /\ cur[s] = pos[s])

\* Reach checks ("never reached": TLC must find each violated).
Finished == /\ Ready
            /\ \A s \in Slots : has[s] /\ cur[s] = MaxRec /\ pos[s] = MaxRec
            /\ \A s \in MovesOf : moved[s] = "done"
NotFinished     == ~Finished
NotFinishedDown == ~(Finished /\ downs >= 1)
\* Every slot that may move went away and came back, and the selection is level.
NotFinishedBack == ~(Finished /\ \A s \in MovesOf : hold[s] = Start(s))
=============================================================================
