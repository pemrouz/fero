---------------------------- MODULE OneNumber ----------------------------
(* Probe P5.  One number per stream, for "a write applied once, in order".

   A stream is one writer's writes to one slot.  Here the writer is a client
   session.  The slot's own leader is a stream too: its number is the slot
   sequence.  Every copy keeps, per stream, ONE number: the high mark `hi`,
   the highest number taken, read at the log end.

   The world (not counted as rules) follows the study's dedup model (E-20):
   two abstract Raft groups; a leader change may drop any part of the
   uncommitted tail, and a dropped tail may come back until the next commit;
   one slot that starts in g0 and may move to g1 by a fence and an open;
   one client, whose copies may be delayed, lost, or forwarded twice by a
   relay; a client restart; a session lapse.

   A leader answers a copy it can take in one of three ways.  It applies it,
   or it refuses it on the row: both go in the log and take the number.  Or
   it refuses it "at the door" (forbidden, fenced, or today's first-send
   refusal): nothing goes in the log and the number is NOT taken.  Today's
   three rules for a refusal outside the log stay as they are, and are
   marked  @keeps  here.

   Lines marked  \* @rule <name>  hold the rules of the one-number form.
   Lines marked  \* @keeps <name>  hold rules of today that stay as they are.
   mutants.txt plants one-line mistakes on both. *)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS N,         \* writes a client life makes
          C,         \* copies of one write a client may send
          MaxCrash,  \* leader changes, over both groups
          MaxDup,    \* copies a relay forwards twice (only with Door off)
          Lives,     \* client lives (a restart starts the next)
          DoMove,    \* may the slot move?
          DoLapse,   \* may a session lapse?
          Pipeline,  \* may the client send n+1 before n is answered?
          Door       \* may a leader refuse a first send outside the log?

VARIABLES log,      \* log[g]: the leader's log of group g, tail included
          ci,       \* ci[g]: how much of log[g] is committed
          alt,      \* alt[g]: a dropped tail that may still come back
          msgs,     \* copies in flight
          life,     \* the client's current life
          status,   \* status[n]: what the current life was told about write n
          copies,   \* copies[n]: copies of write n the current life has sent
          reg,      \* reg[s]: "live" or "lapsed" (committed in #sessions)
          crashes, dups,
          door      \* ghost: the writes <<life, n>> told "refused at the door"

vars == <<log, ci, alt, msgs, life, status, copies, reg, crashes, dups, door>>

G     == {"g0", "g1"}
Lifes == 1..Lives
Sid(l) == l                                           \* @keeps new.session
Sids  == 1..Lives

Max(S) == CHOOSE x \in S : \A y \in S : y <= x
Min(S) == CHOOSE x \in S : \A y \in S : x <= y

IsW(e) == e.t = "w"
Ws(L)  == {i \in DOMAIN L : L[i].t = "w"}

(* ---- the stream table, read from a log ---- *)
NoTab == [hi  |-> [s \in Sids |-> 0], fl |-> [s \in Sids |-> 0],
          ans |-> {}, seq |-> 0]

Base(L) == IF \E i \in DOMAIN L : L[i].t = "open"
           THEN L[CHOOSE i \in DOMAIN L : L[i].t = "open"].tab      \* @rule open.table
           ELSE NoTab

Hi(L, s)  == Max({Base(L).hi[s]} \cup {L[i].n  : i \in {j \in Ws(L) : L[j].sid = s}})
Fl(L, s)  == Max({Base(L).fl[s]} \cup {L[i].fl : i \in {j \in Ws(L) : L[j].sid = s}})
SlotAt(L)    == Base(L).seq + Cardinality(Ws(L))
Row(e)    == <<e.sid, e.n, e.out, e.life>>
Kept(L, a) == a[2] >= Fl(L, a[1])                                   \* @rule keep.floor
AnsOf(L, upto) ==
    {a \in Base(L).ans \cup {Row(L[i]) : i \in {j \in Ws(L) : j <= upto}} : Kept(L, a)}

Tab(L) == [hi  |-> [s \in Sids |-> Hi(L, s)],                       \* @rule carry.hi
           fl  |-> [s \in Sids |-> Fl(L, s)],                       \* @probe carry.floor
           ans |-> AnsOf(L, Len(L)),                                \* @rule carry.ans
           seq |-> SlotAt(L)]                                          \* @rule carry.seq

Holds(g) == IF g = "g0" THEN \A i \in DOMAIN log[g] : log[g][i].t # "fence"
                        ELSE \E i \in DOMAIN log[g] : log[g][i].t = "open"

(* The high mark a leader reads.  A lapsed session's row is forgotten. *)
ReadEnd(g) == log[g]                                                \* @rule read.logend
HiAt(g, s) == IF reg[s] = "lapsed" THEN 0 ELSE Hi(ReadEnd(g), s)

(* ---- the take rule: one comparison pair on one number ---- *)
CanTake(m, hi) == /\ m.p <= hi                                      \* @rule take.before
                  /\ hi < m.n                                       \* @rule take.above
IsDup(m, hi)   == m.n <= hi

Init == /\ log = [g \in G |-> <<>>] /\ ci = [g \in G |-> 0]
        /\ alt = [g \in G |-> <<>>]
        /\ msgs = {} /\ life = 1
        /\ status = [n \in 1..N |-> "none"] /\ copies = [n \in 1..N |-> 0]
        /\ reg = [s \in Sids |-> "live"]
        /\ crashes = 0 /\ dups = 0 /\ door = {}

Floor == IF \A n \in 1..N : status[n] # "none" THEN N + 1
         ELSE Min({n \in 1..N : status[n] = "none"})

(* ---- the client ---- *)
PrevSent(n) == IF n = 1 THEN TRUE ELSE copies[n - 1] > 0
PrevTold(n) == IF n = 1 THEN TRUE ELSE status[n - 1] # "none"
\* The number before n: the last one not refused at the door.
Before(n)   == Max({0} \cup {k \in 1..(n - 1) : status[k] # "door"})
Send(n) ==
    /\ status[n] = "none" /\ copies[n] < C
    /\ PrevSent(n)                                                  \* @rule number.order
    /\ Pipeline \/ PrevTold(n)
    /\ msgs' = msgs \cup {[sid |-> Sid(life), life |-> life, n |-> n,
                           p |-> Before(n),                         \* @rule number.before
                           fl |-> Floor, c |-> copies[n] + 1]}
    /\ copies' = [copies EXCEPT ![n] = @ + 1]
    /\ UNCHANGED <<log, ci, alt, life, status, reg, crashes, dups, door>>

Restart ==
    /\ life < Lives
    /\ life' = life + 1
    /\ status' = [n \in 1..N |-> "none"] /\ copies' = [n \in 1..N |-> 0]
    /\ UNCHANGED <<log, ci, alt, msgs, reg, crashes, dups, door>>

Told(m, x) == IF m.life = life /\ status[m.n] = "none"
              THEN [status EXCEPT ![m.n] = x] ELSE status

(* ---- a leader takes a copy ---- *)
Deliver(m, g, keep) ==
    /\ m \in msgs
    /\ IF keep THEN dups < MaxDup /\ dups' = dups + 1 /\ msgs' = msgs
               ELSE dups' = dups /\ msgs' = msgs \ {m}
    \* A relay forwards a copy once, as long as some refusal is outside the log.
    /\ keep => ~Door                                                \* @keeps forward.once
    /\ LET L  == log[g]
           hi == HiAt(g, m.sid)
       IN
       /\ Holds(g)                               \* else answered "moved"
       /\ IF reg[m.sid] = "lapsed"                                  \* @keeps take.live
          THEN /\ status' = Told(m, "unknown") /\ UNCHANGED <<log, door>>
          ELSE IF CanTake(m, hi)
          THEN \/ /\ \E out \in {"ok", "no"} :
                      log' = [log EXCEPT ![g] = Append(L,
                               [t |-> "w", sid |-> m.sid, life |-> m.life,
                                n |-> m.n,                          \* @rule mark.entry
                                fl |-> m.fl, out |-> out,
                                seq |-> SlotAt(L) + 1])]            \* @keeps stamp.next
                  /\ UNCHANGED <<status, door>>
               \/ /\ Door
                  /\ m.c = 1                                        \* @keeps first.only
                  /\ m.life = life /\ status[m.n] = "none"
                  /\ copies[m.n] = m.c                              \* @keeps recv.latest
                  /\ status' = [status EXCEPT ![m.n] = "door"]
                  /\ door' = door \cup {<<m.life, m.n>>}
                  /\ UNCHANGED log
          ELSE /\ IsDup(m, hi)                    \* else answered "gap"
               /\ UNCHANGED <<log, door>>
               /\ IF \E a \in AnsOf(L, Len(L)) : a[1] = m.sid /\ a[2] = m.n
                  THEN \E a \in AnsOf(L, ci[g]) :                   \* @rule dup.committed
                         /\ a[1] = m.sid /\ a[2] = m.n
                         /\ status' = Told(m, a[3])                 \* @rule dup.first
                  ELSE status' = Told(m, "skipped")   \* the answer is not kept
    \* A copy that changes nothing is the same as a copy that is lost.
    /\ log' # log \/ status' # status
    /\ UNCHANGED <<ci, alt, life, copies, reg, crashes>>

(* The reply to the waiting request: sent when the entry commits. *)
Learn(g) ==
    /\ ci[g] > 0
    /\ LET e == log[g][ci[g]] IN
       /\ e.t = "w" /\ e.life = life /\ status[e.n] = "none"
       /\ status' = [status EXCEPT ![e.n] = e.out]
    /\ UNCHANGED <<log, ci, alt, msgs, life, copies, reg, crashes, dups, door>>

(* ---- the groups ---- *)
Commit(g) ==
    /\ ci[g] < Len(log[g])
    /\ ci' = [ci EXCEPT ![g] = @ + 1]
    /\ alt' = [alt EXCEPT ![g] = <<>>]
    /\ UNCHANGED <<log, msgs, life, status, copies, reg, crashes, dups, door>>

TailOf(g) == SubSeq(log[g], ci[g] + 1, Len(log[g]))
CL(g)   == SubSeq(log[g], 1, ci[g])

(* A leader change: the new leader has the committed part and any prefix of
   the tail.  The dropped tail may come back with a later leader. *)
Crash(g) ==
    /\ crashes < MaxCrash /\ TailOf(g) # <<>>
    /\ \E k \in 0..(Len(TailOf(g)) - 1) :
         log' = [log EXCEPT ![g] = CL(g) \o SubSeq(TailOf(g), 1, k)]
    /\ alt' = [alt EXCEPT ![g] = TailOf(g)]
    /\ crashes' = crashes + 1
    /\ UNCHANGED <<ci, msgs, life, status, copies, reg, dups, door>>

Revive(g) ==
    /\ crashes < MaxCrash /\ alt[g] # <<>> /\ alt[g] # TailOf(g)
    /\ log' = [log EXCEPT ![g] = CL(g) \o alt[g]]
    /\ alt' = [alt EXCEPT ![g] = TailOf(g)]
    /\ crashes' = crashes + 1
    /\ UNCHANGED <<ci, msgs, life, status, copies, reg, dups, door>>

(* ---- the slot move: a fence in g0, then an open in g1 ---- *)
Fence ==
    /\ DoMove /\ Holds("g0")
    /\ log' = [log EXCEPT !["g0"] = Append(@, [t |-> "fence"])]
    /\ UNCHANGED <<ci, alt, msgs, life, status, copies, reg, crashes, dups, door>>

Open ==
    /\ ~Holds("g1")
    /\ \E i \in 1..ci["g0"] :
         /\ log["g0"][i].t = "fence"
         /\ log' = [log EXCEPT !["g1"] = Append(@,
                      [t |-> "open", tab |-> Tab(SubSeq(log["g0"], 1, i))])]
    /\ UNCHANGED <<ci, alt, msgs, life, status, copies, reg, crashes, dups, door>>

Lapse(s) ==
    /\ DoLapse /\ reg[s] = "live"
    /\ reg' = [reg EXCEPT ![s] = "lapsed"]
    /\ UNCHANGED <<log, ci, alt, msgs, life, status, copies, crashes, dups, door>>

Next == \/ \E n \in 1..N : Send(n)
        \/ Restart
        \/ \E m \in msgs, g \in G, keep \in BOOLEAN : Deliver(m, g, keep)
        \/ \E g \in G : Learn(g) \/ Commit(g) \/ Crash(g) \/ Revive(g)
        \/ Fence \/ Open
        \/ \E s \in Sids : Lapse(s)

Spec == Init /\ [][Next]_vars

(* ---- the properties the five marks hold today ---- *)
CW == SelectSeq(CL("g0"), IsW) \o SelectSeq(CL("g1"), IsW)
StreamOf(s) == SelectSeq(CW, LAMBDA e : e.sid = s)

\* ONCE: no write is committed twice (F-02).
Once == \A i, j \in DOMAIN CW :
          i < j => ~(CW[i].life = CW[j].life /\ CW[i].n = CW[j].n)

\* ORDER and NOGAP: a stream's committed numbers rise in log order, across
\* the move, and the only numbers they skip are writes refused at the door.
InOrder == \A s \in Sids :
             LET S == StreamOf(s) IN
             \A i \in DOMAIN S :
               LET lo == IF i = 1 THEN 0 ELSE S[i - 1].n IN
               /\ lo < S[i].n
               /\ \A k \in (lo + 1)..(S[i].n - 1) : <<S[i].life, k>> \in door

\* REFUSED, outside the log: a write told "refused at the door" is never
\* in the committed log.
DoorTrue == \A d \in door : \A i \in DOMAIN CW :
              ~(CW[i].life = d[1] /\ CW[i].n = d[2])

\* SEQ: the slot's own number.  Positions are 1, 2, 3, ... across the move,
\* so no position names two records.
SlotSeq == \A i \in DOMAIN CW : CW[i].seq = i

\* TRUE and REFUSED: what the client was told is in the committed log, as a
\* write of its own life.  With Once, a write told "no" is never applied.
Truth == \A n \in 1..N :
           /\ status[n] \in {"ok", "no"} =>
                \E i \in DOMAIN CW : /\ CW[i].life = life /\ CW[i].n = n
                                     /\ CW[i].out = status[n]
           /\ status[n] = "skipped" =>
                \E i \in DOMAIN CW : CW[i].life = life /\ CW[i].n = n

\* A client is never left with "skipped" for a write it holds no answer to.
NoSkip == \A n \in 1..N : status[n] # "skipped"

\* No write sits after the fence in g0 or before the open in g1.
Shape == /\ \A i, j \in DOMAIN log["g0"] :
              (log["g0"][i].t = "fence" /\ log["g0"][j].t = "w") => j < i
         /\ \A i, j \in DOMAIN log["g1"] :
              (log["g1"][i].t = "open" /\ log["g1"][j].t = "w") => i < j

Safe == Once /\ InOrder /\ SlotSeq /\ Truth /\ DoorTrue /\ NoSkip /\ Shape

(* Sanity: these must FAIL, to show the model can get there. *)
Moved    == \E i \in 1..ci["g1"] : log["g1"][i].t = "w"
NotGoal  == ~((\A n \in 1..N : status[n] = "ok") /\ (DoMove => Moved))
NotDoorGoal == ~(status[1] = "door" /\ status[N] = "ok")
=============================================================================
