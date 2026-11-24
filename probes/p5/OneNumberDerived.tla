------------------------- MODULE OneNumberDerived -------------------------
(* Probe P5, second model.  The one-number form for a derived stream.

   A deriver reads a source slot and writes outputs to two output slots.
   Its stream to one output slot is numbered by the source: the number of a
   write is the source record's sequence and the write's place within the
   record (here r * K + k).  The numbers rise but are not 1, 2, 3, ...: a
   record may write nothing to a slot.  So each write names its own number
   and the number before it, and the take rule is the same as for a client:

       before <= hi < number

   A life of the deriver sends each write once and awaits nothing.  When a
   life ends (a crash, a gap, a lost write) the next life reads the committed
   high marks, starts from the lowest, and its first write to each slot names
   0 as the number before.

   The world follows the study's models E-30 and E-61: source records are
   already committed; output slot X stays in group b0; output slot Y starts
   in b1 and may move INTO b0 by a fence and an open; a leader change may
   drop any part of an uncommitted tail, and the tail may come back; copies
   arrive in any order, once, or never. *)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS R,         \* source records
          K,         \* numbers one record may use per slot
          Lives,     \* lives of the deriver
          MaxCrash,  \* leader changes, over both groups
          DoMove     \* may slot Y move?

VARIABLES log, ci, alt, msgs, life, pc, prev, crashes
vars == <<log, ci, alt, msgs, life, pc, prev, crashes>>

G     == {"b0", "b1"}
Slots == {"X", "Y"}

Max(S) == CHOOSE x \in S : \A y \in S : y <= x
Min(S) == CHOOSE x \in S : \A y \in S : x <= y

(* What each source record writes, in order.  Record 2 writes twice to Y;
   records 2 and 3 skip a slot, where the deriver sends a bare mark. *)
Outs(r) == CASE r = 1 -> <<"X", "Y">>
             [] r = 2 -> <<"Y", "Y">>
             [] OTHER -> <<"X">>

PlaceIn(r, i) == Cardinality({j \in 1..i : Outs(r)[j] = Outs(r)[i]})
Writes(r) == [i \in 1..Len(Outs(r)) |->
                [slot |-> Outs(r)[i], n |-> r * K + PlaceIn(r, i)]]     \* @keeps number.source
Bare(r, s) == IF \E i \in 1..Len(Outs(r)) : Outs(r)[i] = s THEN <<>>
              ELSE <<[slot |-> s, n |-> r * K]>>
RecW(r) == Writes(r) \o Bare(r, "X") \o Bare(r, "Y")

RECURSIVE Prog(_)
Prog(r) == IF r > R THEN <<>> ELSE RecW(r) \o Prog(r + 1)
All == Prog(1)
StartIdx(r) == Len(All) - Len(Prog(r)) + 1

(* ---- the stream table of one slot, read from a log ---- *)
WsOf(L, s) == {i \in DOMAIN L : L[i].t = "w" /\ L[i].slot = s}          \* @rule key.slot
HasOpen(L) == \E i \in DOMAIN L : L[i].t = "open"
Base(L, s) == IF s = "Y" /\ HasOpen(L)
              THEN L[CHOOSE i \in DOMAIN L : L[i].t = "open"].hi        \* @rule open.table
              ELSE 0
Hi(L, s) == Max({Base(L, s)} \cup {L[i].n : i \in WsOf(L, s)})

Holds(g, s) ==
    IF s = "X" THEN g = "b0"
    ELSE IF g = "b1" THEN \A i \in DOMAIN log[g] : log[g][i].t # "fence"
    ELSE HasOpen(log[g])

CL(g)     == SubSeq(log[g], 1, ci[g])
TailOf(g) == SubSeq(log[g], ci[g] + 1, Len(log[g]))

ReadEnd(g) == log[g]                                                    \* @rule read.logend

CanTake(m, hi) == /\ m.p <= hi                                          \* @rule take.before
                  /\ hi < m.n                                           \* @rule take.above

Init == /\ log = [g \in G |-> <<>>] /\ ci = [g \in G |-> 0]
        /\ alt = [g \in G |-> <<>>]
        /\ msgs = {} /\ life = 1 /\ pc = 1
        /\ prev = [s \in Slots |-> 0]
        /\ crashes = 0

(* ---- the deriver ---- *)
Send ==
    /\ pc <= Len(All)
    /\ LET w == All[pc] IN
       /\ msgs' = msgs \cup {[slot |-> w.slot, n |-> w.n,
                              p |-> prev[w.slot],                       \* @rule number.before
                              life |-> life]}
       /\ prev' = [prev EXCEPT ![w.slot] = w.n]                         \* @rule number.chain
    /\ pc' = pc + 1
    /\ UNCHANGED <<log, ci, alt, life, crashes>>

(* The committed high mark of a slot, as marks(name) reads it. *)
MarkLog(g) == CL(g)                                                     \* @keeps marks.committed
Mark(s) == IF s = "X" THEN Hi(MarkLog("b0"), "X")
           ELSE IF HasOpen(CL("b0")) THEN Hi(MarkLog("b0"), "Y")
           ELSE Hi(MarkLog("b1"), "Y")
LowMark == Min({Mark(s) : s \in Slots})                                 \* @keeps marks.lowest

\* What a new life names before its first write to each slot.
FreshPrev == [s \in Slots |-> 0]                                        \* @rule number.start
FreshIdx  == StartIdx(Max({1, LowMark \div K}))

Restart ==
    /\ life < Lives
    /\ life' = life + 1
    /\ pc' = FreshIdx
    /\ prev' = FreshPrev
    /\ UNCHANGED <<log, ci, alt, msgs, crashes>>

(* ---- a leader takes a copy ---- *)
Deliver(m, g) ==
    /\ m \in msgs
    /\ msgs' = msgs \ {m}
    \* A copy answered moved, skipped or gap changes nothing: it is the same
    \* as a copy that is lost, so only a taken copy is a step.
    /\ Holds(g, m.slot) /\ CanTake(m, Hi(ReadEnd(g), m.slot))
    /\ log' = [log EXCEPT ![g] = Append(@,
                 [t |-> "w", slot |-> m.slot, n |-> m.n])]              \* @rule mark.entry
    /\ UNCHANGED <<ci, alt, life, pc, prev, crashes>>

(* ---- the groups ---- *)
Commit(g) ==
    /\ ci[g] < Len(log[g])
    /\ ci' = [ci EXCEPT ![g] = @ + 1]
    /\ alt' = [alt EXCEPT ![g] = <<>>]
    /\ UNCHANGED <<log, msgs, life, pc, prev, crashes>>

Crash(g) ==
    /\ crashes < MaxCrash /\ TailOf(g) # <<>>
    /\ \E k \in 0..(Len(TailOf(g)) - 1) :
         log' = [log EXCEPT ![g] = CL(g) \o SubSeq(TailOf(g), 1, k)]
    /\ alt' = [alt EXCEPT ![g] = TailOf(g)]
    /\ crashes' = crashes + 1
    /\ UNCHANGED <<ci, msgs, life, pc, prev>>

Revive(g) ==
    /\ crashes < MaxCrash /\ alt[g] # <<>> /\ alt[g] # TailOf(g)
    /\ log' = [log EXCEPT ![g] = CL(g) \o alt[g]]
    /\ alt' = [alt EXCEPT ![g] = TailOf(g)]
    /\ crashes' = crashes + 1
    /\ UNCHANGED <<ci, msgs, life, pc, prev>>

(* ---- slot Y moves from b1 into b0 ---- *)
Fence ==
    /\ DoMove /\ Holds("b1", "Y")
    /\ log' = [log EXCEPT !["b1"] = Append(@, [t |-> "fence"])]
    /\ UNCHANGED <<ci, alt, msgs, life, pc, prev, crashes>>

Open ==
    /\ ~HasOpen(log["b0"])
    /\ \E i \in 1..ci["b1"] :
         /\ log["b1"][i].t = "fence"
         /\ log' = [log EXCEPT !["b0"] = Append(@,
                      [t |-> "open",
                       hi |-> Hi(SubSeq(log["b1"], 1, i), "Y")])]       \* @rule carry.hi
    /\ UNCHANGED <<ci, alt, msgs, life, pc, prev, crashes>>

Next == \/ Send \/ Restart
        \/ \E m \in msgs, g \in G : Deliver(m, g)
        \/ \E g \in G : Commit(g) \/ Crash(g) \/ Revive(g)
        \/ Fence \/ Open

Spec == Init /\ [][Next]_vars

(* ---- the property ---- *)
NumsOf(L, s) == LET S == SelectSeq(L, LAMBDA e : e.t = "w" /\ e.slot = s)
                IN  [i \in DOMAIN S |-> S[i].n]
Done(s) == IF s = "X" THEN NumsOf(CL("b0"), "X")
           ELSE NumsOf(CL("b1"), "Y") \o NumsOf(CL("b0"), "Y")
Chain(s) == LET S == SelectSeq(All, LAMBDA w : w.slot = s)
            IN  [i \in DOMAIN S |-> S[i].n]

\* ONCE, ORDER and NOGAP in one: what a slot has committed is the first part
\* of what the deriver makes for it.  No output twice, none out of order,
\* none missing before a later one.
Safe == \A s \in Slots :
          /\ Len(Done(s)) <= Len(Chain(s))
          /\ \A i \in DOMAIN Done(s) : Done(s)[i] = Chain(s)[i]

(* CAN FINISH: a small check for a stall.  From any state, if a new life
   starts now and nothing else goes wrong (every copy arrives in order, every
   entry commits, a move in flight completes), every slot ends with all its
   outputs.  The fold below plays that calm run with the model's own take
   rule and the model's own start of a life. *)
HiEnd(s) == IF s = "X" THEN Hi(log["b0"], "X")
            ELSE IF HasOpen(log["b0"]) THEN Hi(log["b0"], "Y")
            ELSE Hi(log["b1"], "Y")
RECURSIVE Calm(_, _, _)
Calm(i, hi, pv) ==
    IF i > Len(All) THEN hi
    ELSE LET w == All[i]
             m == [p |-> pv[w.slot], n |-> w.n]
         IN  Calm(i + 1,
                  IF CanTake(m, hi[w.slot]) THEN [hi EXCEPT ![w.slot] = w.n] ELSE hi,
                  [pv EXCEPT ![w.slot] = w.n])
CanFinish ==
    LET end == Calm(FreshIdx, [s \in Slots |-> HiEnd(s)], FreshPrev)
    IN  \A s \in Slots : end[s] = Chain(s)[Len(Chain(s))]

(* Sanity: this must FAIL, to show the model can get there. *)
Moved   == Len(NumsOf(CL("b0"), "Y")) > 0 /\ Len(NumsOf(CL("b1"), "Y")) > 0
NotGoal == ~((\A s \in Slots : Done(s) = Chain(s)) /\ (DoMove => Moved))
=============================================================================
