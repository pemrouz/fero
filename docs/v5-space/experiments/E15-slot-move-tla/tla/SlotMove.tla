------------------------------ MODULE SlotMove ------------------------------
(***************************************************************************)
(* The v5 slot move (DESIGN-V5 4.2, second round), written in TLA+ from   *)
(* docs/v5-spec/slot_move.md for E-15 of the v5 design-space study.       *)
(*                                                                         *)
(* Shard A (index 0) holds slot s; shards B (1) and C (2) can import it.   *)
(* Each shard is an abstract Raft group: a committed log `com`, the        *)
(* current leader's uncommitted tail, a count of depositions, the tails    *)
(* lost by earlier leaders that may still come back, the answers waiting   *)
(* for a commit, and (only for one mutant) the leader's volatile move.     *)
(* An unclean recovery (at most one a run) cuts one shard's committed log  *)
(* back to any prefix, drops its tail and bumps its epoch; then the        *)
(* recovery rule decides whether s reopens there. The slot table in #meta  *)
(* is a register written by messages that carry a version and answered by  *)
(* acks. One client sends a few writes, resends them, and sends each copy  *)
(* to any shard. Messages sit in a set: delivery does not remove them      *)
(* (duplication), any may be delivered at any time (delay, reordering),    *)
(* and one never delivered is lost. Every report a shard's log (or an ack) *)
(* makes true is put in the set at once ("Settle").                       *)
(*                                                                         *)
(* Values follow slot_move.py's state one for one, so the two checkers can *)
(* be compared state count for state count and trace for trace:           *)
(*   a position is <<epoch, seq>>; "none" is <<>> for positions, the       *)
(*   carried state and END, -1 for move names and incarnations;            *)
(*   a table version is a flat sequence of integers, compared              *)
(*   lexicographically (slot_move.py's nested tuples, flattened).          *)
(*                                                                         *)
(* Log entries (tuples, kind first):                                       *)
(*   <<"w", aid, pos>>                 a write to slot s                   *)
(*   <<"wt", aid>>                     a write to slot t (always at A)     *)
(*   <<"exporting", tgt>>              A, step 0; the move's name is this  *)
(*                                     entry's 0-based index in A's log    *)
(*   <<"fenced", name, N, tgt, tep>>   A, step 2; tep: the target's        *)
(*                                     incarnation whose ready report A    *)
(*                                     acted on                            *)
(*   <<"cancel", name>>                A cancels before its fence          *)
(*   <<"unfenced", name, N>>           A reopens s at N, after the abort   *)
(*   <<"importing", name>>             target, step 1                      *)
(*   <<"imp", name, to, ws, end, car>> target: its copy of s up to `to`    *)
(*   <<"open", name, N>>               target, step 3                      *)
(*   <<"abort", name>>                 target gives the move up            *)
(*   <<"rec", "open"|"shut">>          an unclean recovery; epoch 1 after  *)
(*                                                                         *)
(* Messages: <<"req", dst, aid, copy, resent>>, <<"export", tgt, name>>,   *)
(*   <<"sub", tgt, name>>, <<"data", tgt, name, p, q, ws, end, car>>,      *)
(*   <<"ready", tgt, name, p, epoch>>, <<"cancelled", tgt, name>>,         *)
(*   <<"aborted", tgt, name, epoch>>, <<"tw", holder, version, writer>>,   *)
(*   <<"tack", holder, version, writer>>.                                  *)
(***************************************************************************)
EXTENDS Integers, Sequences, FiniteSets, TLC, TLCExt

CONSTANTS
  K,          \* number of shards: A = 0, B = 1, C = 2
  WSlots,     \* the client's writes, in id order: a sequence of "s" or "t"
  W,          \* the dedup window (0: no window)
  R,          \* resends allowed per write
  D,          \* depositions allowed per shard
  M,          \* moves A may start in a run
  Rec,        \* is one unclean recovery allowed?
  V,          \* the variant: "design", "fixed", a reading, or a mutant
  Fix,        \* the set of fixes in force (slot_move.md's five, or fewer)
  WithCalm,   \* also build the liveness graph (property 7)
  Soft        \* report property failures by printing, and keep exploring

VARIABLES shards, table, cl, net, started, recovered, maxpos, calm
vars == <<shards, table, cl, net, started, recovered, maxpos, calm>>

Sh == 0..(K - 1)
Tg == 1..(K - 1)
NW == Len(WSlots)
Named == V # "no-exporting"
NONE == -1
Z == <<0, 0>>

\* Memoization of the log views (TLCExt!TLCCache): a pure speed-up. The key
\* names the view and holds every value it reads; with UseCache = FALSE
\* the plain expression is used, and the two give the same state counts.
CONSTANT UseCache
Cache(expr, key) == IF UseCache THEN TLCCache(expr, key) ELSE expr

-----------------------------------------------------------------------------
(* Positions and versions *)

PLt(p, q) == p[1] < q[1] \/ (p[1] = q[1] /\ p[2] < q[2])
PLe(p, q) == ~PLt(q, p)
PMax(p, q) == IF PLt(p, q) THEN q ELSE p

RECURSIVE VLt(_, _)
VLt(a, b) == IF b = <<>> THEN FALSE
             ELSE IF a = <<>> THEN TRUE
             ELSE IF a[1] # b[1] THEN a[1] < b[1]
             ELSE VLt(Tail(a), Tail(b))

MaxInt(S) == CHOOSE x \in S : \A y \in S : y <= x

-----------------------------------------------------------------------------
(* Views of a log *)

Kind(e) == e[1]
Idx(es, k) == {i \in 1..Len(es) : Kind(es[i]) = k}
Pre(es, n) == SubSeq(es, 1, n)
IsPrefix(g, h) == Len(g) <= Len(h) /\ SubSeq(h, 1, Len(g)) = g

\* Does this log hold s open? The last entry that decides wins: a fence
\* shuts, unfenced or open opens, a recovery as it decided, and (only at a
\* target, only in the mutant where B aborts after open) an abort shuts.
\* With no such entry, only A holds s (genesis).
Decides(e, isA) == Kind(e) \in {"fenced", "unfenced", "open", "rec"}
                   \/ (Kind(e) = "abort" /\ ~isA)
Effect(e) == CASE Kind(e) = "fenced" -> FALSE
               [] Kind(e) \in {"unfenced", "open"} -> TRUE
               [] Kind(e) = "rec" -> e[2] = "open"
               [] OTHER -> FALSE
IsOpen(es, isA) ==
  Cache(LET Ds == {i \in 1..Len(es) : Decides(es[i], isA)}
        IN IF Ds = {} THEN isA ELSE Effect(es[MaxInt(Ds)]), <<"O", es, isA>>)

Epoch(es) == IF Idx(es, "rec") = {} THEN 0 ELSE 1

PosKinds == {"w", "imp", "fenced", "unfenced", "open"}
\* the highest position of s in these entries
RECURSIVE TopF(_, _)
TopF(es, p) == IF es = <<>> THEN p
               ELSE TopF(Tail(es), IF Kind(Head(es)) \in PosKinds
                                   THEN PMax(p, Head(es)[3]) ELSE p)
Top(es) == Cache(TopF(es, Z), <<"P", es>>)

\* the highest position of a write in these entries (mutant no-carried-sequence)
RECURSIVE TopWF(_, _)
TopWF(es, p) == IF es = <<>> THEN p
                ELSE TopWF(Tail(es), IF Kind(Head(es)) = "w"
                                     THEN PMax(p, Head(es)[3]) ELSE p)

\* Property 6 within one log: a write's position is above all before it,
\* and no fence, open or unfence names a lower one.
RECURSIVE WalkF(_, _)
WalkF(es, p) ==
  IF es = <<>> THEN TRUE
  ELSE LET e == Head(es) IN
       CASE Kind(e) = "w" -> IF PLe(e[3], p) THEN FALSE ELSE WalkF(Tail(es), e[3])
         [] Kind(e) \in {"imp", "fenced", "unfenced", "open"} ->
              IF PLt(e[3], p) /\ Kind(e) # "imp" THEN FALSE
              ELSE WalkF(Tail(es), PMax(p, e[3]))
         [] OTHER -> WalkF(Tail(es), p)

WritesOf(es) == {<<es[i][2], es[i][3]>> : i \in Idx(es, "w")}
SRows(es) == WritesOf(es) \cup UNION {es[i][4] : i \in Idx(es, "imp")}

\* A's moves: name -> [tgt, N, can, unf, tep, set]. N: the fence's N (<<>>
\* before the fence); can: cancelled; unf: unfenced at (<<>> if not); tep:
\* the target incarnation fenced on; set: settled by a recovery that left s
\* shut (fix 1: such a fence never reopens s).
AStep(mv, e, i) ==
  CASE Kind(e) = "exporting" ->
         [n \in DOMAIN mv \cup {i} |->
            IF n = i THEN [tgt |-> e[2], N |-> <<>>, can |-> FALSE,
                           unf |-> <<>>, tep |-> NONE, set |-> FALSE]
            ELSE mv[n]]
    [] Kind(e) = "fenced" /\ e[2] \in DOMAIN mv ->
         [mv EXCEPT ![e[2]].N = e[3], ![e[2]].tep = e[5]]
    [] Kind(e) = "cancel" /\ e[2] \in DOMAIN mv -> [mv EXCEPT ![e[2]].can = TRUE]
    [] Kind(e) = "unfenced" /\ e[2] \in DOMAIN mv -> [mv EXCEPT ![e[2]].unf = e[3]]
    [] Kind(e) = "rec" /\ e[2] = "shut" /\ "recovery-ends-move" \in Fix ->
         [n \in DOMAIN mv |-> IF mv[n].N # <<>> /\ mv[n].unf = <<>>
                              THEN [mv[n] EXCEPT !.set = TRUE] ELSE mv[n]]
    [] OTHER -> mv
RECURSIVE AMovesF(_, _, _)
AMovesF(es, i, mv) == IF i > Len(es) THEN mv
                      ELSE AMovesF(es, i + 1, AStep(mv, es[i], i - 1))
AMoves(es) == Cache(AMovesF(es, 1, [n \in {} |-> 0]), <<"A", es>>)

\* A target's imports: name -> [pos, end, car, endi, abi, open, ab, seen]
\* (the latest import of each name). pos: its copy reaches; end: END(N)
\* once it came; endi, abi: 0-based index of the copy holding END, and of
\* the abort; seen: some copy has arrived.
TStep(mv, e, i) ==
  CASE Kind(e) = "importing" ->
         [n \in DOMAIN mv \cup {e[2]} |->
            IF n = e[2] THEN [pos |-> Z, end |-> <<>>, car |-> <<>>, endi |-> NONE,
                              abi |-> NONE, open |-> FALSE, ab |-> FALSE,
                              seen |-> FALSE]
            ELSE mv[n]]
    [] Kind(e) = "imp" /\ e[2] \in DOMAIN mv ->
         LET m == mv[e[2]]
             first == e[5] # <<>> /\ m.end = <<>>
         IN [mv EXCEPT ![e[2]] = [m EXCEPT !.pos = PMax(m.pos, e[3]), !.seen = TRUE,
                                           !.end = IF first THEN e[5] ELSE m.end,
                                           !.car = IF first THEN e[6] ELSE m.car,
                                           !.endi = IF first THEN i ELSE m.endi]]
    [] Kind(e) = "open" /\ e[2] \in DOMAIN mv -> [mv EXCEPT ![e[2]].open = TRUE]
    [] Kind(e) = "abort" /\ e[2] \in DOMAIN mv ->
         [mv EXCEPT ![e[2]].abi = i, ![e[2]].ab = TRUE]
    [] Kind(e) = "rec" /\ e[2] = "open" ->
         [n \in DOMAIN mv |-> IF ~mv[n].ab THEN [mv[n] EXCEPT !.open = TRUE] ELSE mv[n]]
    [] OTHER -> mv
RECURSIVE TMovesF(_, _, _)
TMovesF(es, i, mv) == IF i > Len(es) THEN mv
                      ELSE TMovesF(es, i + 1, TStep(mv, es[i], i - 1))
TMoves(es) == Cache(TMovesF(es, 1, [n \in {} |-> 0]), <<"T", es>>)

LiveImport(es) == LET mv == TMoves(es) IN \E n \in DOMAIN mv : ~mv[n].open /\ ~mv[n].ab

UnderWay(es, mem) ==
  IF Named THEN LET mv == AMoves(es) IN \E n \in DOMAIN mv : ~mv[n].can /\ mv[n].unf = <<>>
  ELSE mem # <<>>

-----------------------------------------------------------------------------
(* Dedup (4.3): the outcomes a log holds, the issuer's highest call id,    *)
(* and the window's floor.                                                 *)

WSlot(a) == WSlots[a]
Dsts(a) == IF WSlot(a) = "s" THEN Sh ELSE {0}

Put(out, a, val) == [b \in DOMAIN out \cup {a} |-> IF b = a THEN val ELSE out[b]]
PutAll(out, outs, w) ==
  [b \in DOMAIN out \cup {o[1] : o \in outs} |->
     IF \E o \in outs : o[1] = b
     THEN LET o == CHOOSE o \in outs : o[1] = b IN <<o[2], o[3], w>>
     ELSE out[b]]
MaxOr0(S) == IF S = {} THEN 0 ELSE MaxInt(S)

DStep(acc, e, w) ==
  LET Hi(a, out) == IF a > acc.hi THEN [out |-> out, hi |-> a, hw |-> w]
                    ELSE [out |-> out, hi |-> acc.hi, hw |-> acc.hw]
  IN CASE Kind(e) = "w" -> Hi(e[2], Put(acc.out, e[2], <<"ok", e[3], w>>))
       [] Kind(e) = "wt" -> Hi(e[2], Put(acc.out, e[2], <<"ok", <<>>, w>>))
       [] Kind(e) = "imp" /\ e[6] # <<>> ->
            LET outs == e[6][1]
                a == IF V = "no-max-merge" THEN MaxOr0({o[1] : o \in outs}) ELSE e[6][2]
            IN Hi(a, PutAll(acc.out, outs, w))
       [] OTHER -> acc
RECURSIVE DedupF(_, _, _)
DedupF(es, i, acc) == IF i > Len(es) THEN acc ELSE DedupF(es, i + 1, DStep(acc, es[i], i))
Dedup(es) == Cache(DedupF(es, 1, [out |-> [a \in {} |-> 0], hi |-> 0, hw |-> 0]), <<"D", es>>)

Floor(hi) == IF W > 0 THEN hi - W ELSE -1

Judge(es, a) ==
  LET d == Dedup(es)
      fl == Floor(d.hi)
  IN IF a \in DOMAIN d.out /\ a > fl
     THEN [r |-> "hit", kind |-> d.out[a][1], pos |-> d.out[a][2], wait |-> d.out[a][3]]
     ELSE IF a <= fl THEN [r |-> "stale", wait |-> d.hw]
     ELSE [r |-> "fresh"]

\* The carried state: the committed outcomes tagged with s, above the
\* floor, and the issuer's highest call id.
Carried(es) ==
  LET d == Dedup(es)
      fl == Floor(d.hi)
  IN IF V = "no-carried-outcomes" THEN <<{}, d.hi>>
     ELSE <<{<<a, d.out[a][1], d.out[a][2]>> :
               a \in {b \in DOMAIN d.out : WSlot(b) = "s" /\ b > fl}}, d.hi>>

\* 2: a leader stamps on from its log end (committed and uncommitted).
NextPos(sh, x) ==
  LET le0 == sh.com \o sh.tail
      le == IF V = "stamp-from-committed"
            THEN sh.com \o SubSeq(sh.tail, sh.inh + 1, Len(sh.tail)) ELSE le0
      p == IF x # 0 /\ V = "no-carried-sequence" THEN TopWF(le, Z) ELSE Top(le)
      ep == IF Epoch(le0) > p[1] THEN Epoch(le0) ELSE p[1]
  IN <<ep, p[2] + 1>>

-----------------------------------------------------------------------------
(* Guards: a forbidding guard reads the whole log, committed or not ("Two  *)
(* kinds of rule"); the mutant guards-on-committed reads three of them on  *)
(* committed entries only.                                                 *)

FG(sh) == sh.com \o sh.tail
RG(sh) == IF V = "guards-on-committed" THEN sh.com ELSE FG(sh)

\* Does shard x take writes to s? Only once s is open in its committed log
\* and nothing in its tail shuts it.
Serving(sh, x) ==
  IF x # 0 /\ V = "b-serves-before-open-commits" THEN IsOpen(FG(sh), FALSE)
  ELSE IF x # 0 /\ V = "b-serves-before-open"
          /\ LET cm == TMoves(sh.com)
                 lm == TMoves(FG(sh))
             IN \E n \in DOMAIN cm : cm[n].end # <<>> /\ cm[n].pos = cm[n].end
                                     /\ ~cm[n].ab /\ ~lm[n].ab
       THEN TRUE
  ELSE IsOpen(sh.com, x = 0) /\ IsOpen(RG(sh), x = 0)

\* The version a table write carries. With fix 2: the move's name, the
\* writer's incarnation, the step (1 for s -> target, 2 for s -> A back).
\* As the text reads ("the newest config winning"): the writer's (epoch,
\* log position).
Ver(n, step, ep, idx) ==
  IF "table-by-move" \in Fix /\ Named THEN <<0, n, ep, step>> ELSE <<ep, idx>>
\* fix 3: a recovery's own table write, at its new epoch
RecVer == IF "table-by-move" \in Fix /\ Named THEN <<1, -1, 0, 0>> ELSE <<1, -1>>

-----------------------------------------------------------------------------
(* Reports: every message the shards' logs (and #meta's acks) make true.   *)

AReports(A) == Cache(
  IF Named
  THEN LET mv == AMoves(A.com)
       IN {IF mv[n].can THEN <<"cancelled", mv[n].tgt, n>> ELSE <<"export", mv[n].tgt, n>> :
             n \in {k \in DOMAIN mv : mv[k].can \/ (mv[k].unf = <<>> /\ ~mv[k].set)}}
  ELSE (IF A.mem # <<>> THEN {<<"export", A.mem[1], NONE>>} ELSE {})
       \cup {<<"cancelled", A.com[i][3], NONE>> : i \in Idx(A.com, "cancel")},
  <<"AR", A.com, A.mem>>)

\* A target's reports about move n. `fixed`: sent as soon as its log makes
\* them true; `cond`: pairs <<ack, report>>, the report being sent once
\* #meta's ack is in the network (an abort is reported only after s -> A
\* is written back).
TRep(x, n, m, rmv, com, ep) ==
  IF m.open
  THEN [fixed |-> IF V = "table-after-open" /\ ~m.ab /\ m.endi # NONE
                  THEN {<<"tw", x, Ver(n, 1, Epoch(Pre(com, m.endi)), m.endi + 1), x>>} ELSE {},
        cond |-> {}]
  ELSE IF ~m.ab
  THEN [fixed |-> IF m.end = <<>>
                  THEN {<<"sub", x, n>>}
                       \cup (IF n \in DOMAIN rmv /\ rmv[n].seen
                             THEN {<<"ready", x, n, rmv[n].pos, ep>>} ELSE {})
                  ELSE IF V # "table-after-open"
                       THEN {<<"tw", x, Ver(n, 1, Epoch(Pre(com, m.endi)), m.endi + 1), x>>}
                       ELSE {},
        cond |-> {}]
  ELSE \* an abort: write s -> A back first (fix 2: always), then report it
       LET wrote == IF V = "abort-keeps-table" THEN FALSE
                    ELSE IF "table-by-move" \in Fix THEN TRUE
                    ELSE m.end # <<>>
           vr == Ver(n, 2, Epoch(Pre(com, m.abi)), m.abi + 1)
       IN IF wrote
          THEN [fixed |-> {<<"tw", 0, vr, x>>},
                cond |-> {<<<<"tack", 0, vr, x>>, <<"aborted", x, n, ep>>>>}]
          ELSE [fixed |-> {<<"aborted", x, n, ep>>}, cond |-> {}]

TRepAll(x, sh) ==
  LET com == sh.com
      ep == Epoch(com)
      rmv == TMoves(IF V = "ready-before-copy-commits" THEN FG(sh) ELSE com)
      mv == TMoves(com)
      lmv == TMoves(FG(sh))
      rs == {TRep(x, n, mv[n], rmv, com, ep) : n \in DOMAIN mv}
  IN [fixed |-> UNION {r.fixed : r \in rs}
                \cup (IF V = "unfence-on-appended-abort"
                      THEN {<<"aborted", x, n, ep>> : n \in {k \in DOMAIN lmv : lmv[k].ab /\ ~lmv[k].open}}
                      ELSE {}),
      cond |-> UNION {r.cond : r \in rs}]

TReports(x, sh, nt) ==
  LET b == Cache(TRepAll(x, sh), <<"R", x, sh.com, sh.tail>>)
  IN b.fixed \cup {c[2] : c \in {c \in b.cond : c[1] \in nt}}

Reports(sh, nt) == AReports(sh[0]) \cup UNION {TReports(x, sh[x], nt) : x \in Tg}

-----------------------------------------------------------------------------
(* Moving to the next state. Every step ends by settling: the new state's  *)
(* reports join the network, and answers the client no longer waits for   *)
(* are dropped.                                                            *)

Prune(sh, c) ==
  [x \in Sh |-> IF sh[x].pend = {} THEN sh[x]
                ELSE [sh[x] EXCEPT !.pend = {p \in @ : c[p[1]].s = 1 /\ c[p[1]].cp = p[2]}]]

Go(sh, tb, c, nt, st, rc, mp) ==
  /\ shards' = Prune(sh, c)
  /\ table' = tb
  /\ cl' = c
  /\ net' = nt \cup Reports(sh, nt)
  /\ started' = st
  /\ recovered' = rc
  /\ maxpos' = mp
  /\ calm' = calm

Set(x, s) == [shards EXCEPT ![x] = s]
App(s, e) == [s EXCEPT !.tail = Append(@, e)]

\* The client takes each released answer at once, or it is lost; it takes
\* only the answer to its latest copy of a pending attempt (4.3).
Takeable(c, r) == c[r[1]].s = 1 /\ c[r[1]].cp = r[2]
Took(c, T) ==
  [i \in DOMAIN c |->
     IF \E r \in T : r[1] = i
     THEN LET r == CHOOSE r \in T : r[1] = i
          IN IF r[3] = "ok" THEN [s |-> 2, q |-> r[4], cp |-> c[i].cp]
             ELSE [s |-> 3, q |-> <<>>, cp |-> c[i].cp]
     ELSE c[i]]
Outcomes(c, rel) ==
  {Took(c, T) : T \in {T \in SUBSET {r \in rel : Takeable(c, r)} :
                         \A r1, r2 \in T : r1[1] = r2[1] => r1 = r2}}

Answer(sh, a, cp, kind, pos, wait) ==
  IF wait <= Len(sh.com) THEN [sh |-> sh, rel |-> {<<a, cp, kind, pos>>}]
  ELSE [sh |-> [sh EXCEPT !.pend = @ \cup {<<a, cp, kind, pos, wait>>}], rel |-> {}]

-----------------------------------------------------------------------------
(* Properties, and how a failure is reported. With Soft, a failure is     *)
(* printed with its step count (the shortest one seen so far by this TLC  *)
(* worker) and the search goes on, so one run gives every property.       *)

Fail(p, steps) ==
  IF TLCGetOrDefault(p, 1000000) > steps
  THEN PrintT(<<"FAIL", p, steps>>) /\ TLCSet(p, steps)
  ELSE TRUE

Opens == {x \in Sh : IsOpen(shards[x].com, x = 0)}

\* 1. at most one shard holds s open
P1 == Cardinality(Opens) <= 1
\* 2. no position is stamped on committed writes by two shards
P2 == \A x, y \in Sh : x # y =>
        {e[2] : e \in WritesOf(shards[x].com)} \cap {e[2] : e \in WritesOf(shards[y].com)} = {}
\* 3. every write committed to s at A before a move's fence is at the target
\*    when the target opens
P3 == \A x \in Tg : \A i \in Idx(shards[x].com, "open") :
        LET com == shards[x].com
            n == com[i][2]
            imps == {j \in 1..(i - 1) : Kind(com[j]) = "importing" /\ com[j][2] = n}
            from == IF imps = {} THEN 0 ELSE MaxInt(imps)
            got == UNION {com[j][4] : j \in {j \in (from + 1)..(i - 1) :
                                               Kind(com[j]) = "imp" /\ com[j][2] = n}}
            Acom == shards[0].com
            fs == {j \in 1..Len(Acom) : Kind(Acom[j]) = "fenced" /\ Acom[j][2] = n}
            upto == IF fs = {} THEN Len(Acom) ELSE CHOOSE j \in fs : \A k \in fs : j <= k
        IN WritesOf(Pre(Acom, upto - (IF fs = {} THEN 0 ELSE 1))) \subseteq got
Count(a) == Cardinality(UNION {{<<x, i>> : i \in {i \in 1..Len(shards[x].com) :
                                    Kind(shards[x].com[i]) \in {"w", "wt"} /\ shards[x].com[i][2] = a}} :
                                x \in Sh})
\* 4. no acknowledged write goes missing from the state of the shard that
\*    holds s (checked only before a recovery)
Holder == IF Opens = {} THEN 0 ELSE CHOOSE x \in Opens : \A y \in Opens : x <= y
P4 == recovered \/
      \A a \in 1..NW : cl[a].s = 2 =>
        IF WSlot(a) = "s" THEN <<a, cl[a].q>> \in SRows(shards[Holder].com)
        ELSE \E i \in Idx(shards[0].com, "wt") : shards[0].com[i][2] = a
\* 5. no attempt id commits twice
P5 == \A a \in 1..NW : Count(a) <= 1
\* 6. a slot's position never goes back in a log (the edge half is in Commit)
P6 == \A x \in Sh : WalkF(shards[x].com, Z)
\* 8. an attempt its issuer took as refused never commits
P8 == \A a \in 1..NW : cl[a].s = 3 => Count(a) = 0
\* 9. whenever a shard holds s open, the table names it
P9 == \A x \in Opens : table.h = x

Props == <<P1, P2, P3, P4, P5, P6, TRUE, P8, P9>>

\* With Soft: always TRUE; prints each property's failure.
SoftInv == calm \/ \A p \in {1, 2, 3, 4, 5, 6, 8, 9} :
                     Props[p] \/ Fail(p, TLCGet("level") - 1)
\* Without Soft: one invariant per property, TLC stops at the first failure.
Inv1 == calm \/ P1
Inv2 == calm \/ P2
Inv3 == calm \/ P3
Inv4 == calm \/ P4
Inv5 == calm \/ P5
Inv6 == calm \/ P6
Inv8 == calm \/ P8
Inv9 == calm \/ P9

-----------------------------------------------------------------------------
(* The steps *)

\* ---- the client: ids rise, the window bounds them; after the recovery it
\*      sends nothing new
Issue(a, d) ==
  /\ ~calm /\ ~recovered
  /\ cl[a].s = 0
  /\ \A b \in 1..(a - 1) : cl[b].s # 0
  /\ ~(W > 0 /\ \E b \in 1..NW : cl[b].s = 1 /\ a - b >= W)
  /\ d \in Dsts(a)
  /\ Go(shards, table, [cl EXCEPT ![a] = [s |-> 1, q |-> <<>>, cp |-> 1]],
        net \cup {<<"req", d, a, 1, FALSE>>}, started, recovered, maxpos)

Resend(a, d) ==
  /\ ~calm /\ ~recovered
  /\ cl[a].s = 1 /\ cl[a].cp <= R
  /\ d \in Dsts(a)
  /\ Go(shards, table, [cl EXCEPT ![a] = [s |-> 1, q |-> <<>>, cp |-> cl[a].cp + 1]],
        net \cup {<<"req", d, a, cl[a].cp + 1, TRUE>>}, started, recovered, maxpos)

\* ---- a shard takes a write: dedup first; a fresh one is stamped and
\*      appended; its answer goes out once its entry commits
OnReq(m) ==
  LET d == m[2]
      a == m[3]
      cp == m[4]
      sh == shards[d]
      le == FG(sh)
      j == Judge(le, a)
      res == CASE j.r = "hit" -> Answer(sh, a, cp, j.kind, j.pos, j.wait)
               [] j.r = "stale" -> Answer(sh, a, cp, "stale", <<>>, j.wait)
               [] OTHER -> IF WSlot(a) = "s"
                           THEN LET pos == NextPos(sh, d)
                                IN Answer(App(sh, <<"w", a, pos>>), a, cp, "ok", pos, Len(le) + 1)
                           ELSE Answer(App(sh, <<"wt", a>>), a, cp, "ok", <<>>, Len(le) + 1)
  IN /\ ~calm
     /\ WSlot(a) = "t" \/ Serving(sh, d)
     /\ \E c2 \in Outcomes(cl, res.rel) :
          Go(Set(d, res.sh), table, c2, net, started, recovered, maxpos)

\* ---- step 0: A's leader appends exporting(s, to tgt), the move's name
AExport(tgt) ==
  LET A == shards[0] IN
  /\ ~calm /\ started < M
  /\ IsOpen(FG(A), TRUE) /\ IsOpen(A.com, TRUE)
  /\ ~UnderWay(FG(A), A.mem)
  /\ IF Named
     THEN Go(Set(0, App(A, <<"exporting", tgt>>)), table, cl, net, started + 1, recovered, maxpos)
     ELSE Go(Set(0, [A EXCEPT !.mem = <<tgt>>]), table, cl, net \cup {<<"export", tgt, NONE>>},
             started + 1, recovered, maxpos)

\* ---- step 1: the target, asked, appends importing(name)
OnExport(m) ==
  LET tgt == m[2]
      n == m[3]
      sh == shards[tgt]
      fg == FG(sh)
  IN /\ ~LiveImport(fg) /\ ~IsOpen(fg, FALSE)
     /\ Named => n \notin DOMAIN TMoves(fg)          \* imported already
     /\ ~Named => Cardinality(Idx(fg, "importing")) < M
     /\ Go(Set(tgt, App(sh, <<"importing", n>>)), table, cl, net, started, recovered, maxpos)

\* Does A know the move n to tgt? (a committed exporting; or, in the mutant,
\* its leader's memory)
ACurOK(A, n, tgt) ==
  IF Named THEN LET mv == AMoves(A.com) IN n \in DOMAIN mv /\ mv[n].tgt = tgt
  ELSE A.mem # <<>> /\ A.mem[1] = tgt
ACur(A, n, tgt) ==
  IF Named THEN AMoves(A.com)[n]
  ELSE [tgt |-> tgt, N |-> <<>>, can |-> FALSE, unf |-> <<>>, tep |-> NONE, set |-> FALSE]

\* ---- before its fence, A answers the target's subscription with s's
\*      committed records
OnSub(m) ==
  LET tgt == m[2]
      n == m[3]
      A == shards[0]
      d == <<"data", tgt, n, <<>>, Top(A.com), WritesOf(A.com), <<>>, <<>>>>
  IN /\ ACurOK(A, n, tgt)
     /\ LET mm == ACur(A, n, tgt) IN mm.N = <<>> /\ ~mm.can /\ mm.unf = <<>>
     /\ IsOpen(A.com, TRUE)
     /\ d \notin net
     /\ Go(shards, table, cl, net \cup {d}, started, recovered, maxpos)

\* ---- step 2: A fences on the target's ready report; N is s's last
\*      position in its log (at least in its epoch)
TryFence(tgt, n, tep) ==
  LET A == shards[0]
      fg == FG(A)
      src == IF V = "fence-N-from-committed" THEN A.com ELSE fg
      N0 == Top(src)
      ep == Epoch(fg)
      N == IF N0[1] < ep THEN <<ep, N0[2]>> ELSE N0
  IN /\ ACurOK(A, n, tgt)
     /\ (Named /\ n \in DOMAIN AMoves(fg)) =>
          LET lm == AMoves(fg)[n] IN lm.N = <<>> /\ ~lm.can /\ lm.unf = <<>>
     /\ IsOpen(fg, TRUE) /\ IsOpen(A.com, TRUE)
     /\ Go(Set(0, App(A, <<"fenced", n, N, tgt, tep>>)), table, cl, net, started, recovered, maxpos)

OnReady(m) == V # "fence-without-ready" /\ TryFence(m[2], m[3], m[5])

\* The fence of move n in src, if s was not given back: <<N, tgt, tep>>
RECURSIVE FenceUnnamedF(_, _)
FenceUnnamedF(es, F) ==
  IF es = <<>> THEN F
  ELSE LET e == Head(es) IN
       FenceUnnamedF(Tail(es),
         IF Kind(e) = "fenced" THEN <<e[3], e[4], e[5]>>
         ELSE IF Kind(e) = "unfenced" \/ (Kind(e) = "rec" /\ "recovery-ends-move" \in Fix)
         THEN <<>> ELSE F)
FenceOf(A, n, src) ==
  IF Named
  THEN LET mv == AMoves(src) IN
       IF n \notin DOMAIN mv THEN <<>>
       ELSE LET m == mv[n] IN
            IF m.N = <<>> \/ m.unf # <<>> \/ m.can \/ m.set THEN <<>> ELSE <<m.N, m.tgt, m.tep>>
  ELSE FenceUnnamedF(src, <<>>)

\* ---- after its fence commits, A sends the delta since the ready position,
\*      END(N) and the carried state (fix 4: for the incarnation it fenced on)
OnReadySend(m) ==
  LET tgt == m[2]
      n == m[3]
      p == m[4]
      A == shards[0]
      src == IF V = "stream-before-fence-commits" THEN FG(A) ELSE A.com
      F == FenceOf(A, n, src)
  IN /\ F # <<>> /\ F[2] = tgt
     /\ ~PLt(F[1], p)
     /\ LET N == F[1]
            ws == {w \in WritesOf(src) : PLt(p, w[2]) /\ PLe(w[2], N)}
            car0 == Carried(src)
            car == IF "fence-binds-incarnation" \in Fix THEN Append(car0, F[3]) ELSE car0
            d == <<"data", tgt, n, p, N, ws, N, car>>
        IN d \notin net /\ Go(shards, table, cl, net \cup {d}, started, recovered, maxpos)

\* ---- the target appends a copy of s's records it receives
OnData(m) ==
  LET tgt == m[2]
      n == m[3]
      p == m[4]
      q == m[5]
      ws == m[6]
      end == m[7]
      car == m[8]
      sh == shards[tgt]
      cm == TMoves(sh.com)
      lmv == TMoves(FG(sh))
  IN /\ n \in DOMAIN cm                    \* importing must be committed
     /\ n \in DOMAIN lmv /\ ~lmv[n].open /\ ~lmv[n].ab
     /\ lmv[n].end = <<>>                  \* it has END(N) already
     /\ LET pos == lmv[n].pos
            Do(c2) == LET top == IF PLt(pos, q) THEN q ELSE pos
                          e == <<"imp", n, top, {w \in ws : PLt(pos, w[2])}, end, c2>>
                      IN Go(Set(tgt, App(sh, e)), table, cl, net, started, recovered, maxpos)
        IN IF p = <<>>
           THEN /\ ~(lmv[n].seen /\ PLe(q, pos))        \* a snapshot before the fence
                /\ Do(car)
           ELSE /\ ~PLt(pos, p)                         \* no gap
                /\ PLt(pos, q) \/ end # <<>>
                /\ "fence-binds-incarnation" \in Fix => car[3] = Epoch(FG(sh))
                /\ Do(<<car[1], car[2]>>)

\* ---- #meta commits a table write if it is newer (a versioned register)
OnTw(m) ==
  LET val == m[2]
      ver == m[3]
      ack == <<"tack", val, ver, m[4]>>
  IN /\ IF "table-unversioned" \in Fix
        THEN ~(table = [h |-> val, v |-> ver] /\ ack \in net)
        ELSE /\ ~VLt(ver, table.v)
             /\ ~(ver = table.v /\ val # table.h)
             /\ ~(ver = table.v /\ ack \in net)
     /\ Go(shards, [h |-> val, v |-> ver], cl, net \cup {ack}, started, recovered, maxpos)

\* ---- A, on the target's committed abort: end a move it had not fenced,
\*      or reopen s at N (fix 4: only on an abort of the incarnation it
\*      fenced on or a newer one; fix 5: in the abort's epoch if higher)
OnAborted(m) ==
  LET tgt == m[2]
      n == m[3]
      tep == m[4]
      A == shards[0]
      fg == FG(A)
      mv == AMoves(fg)
      Unfence ==
        /\ ~IsOpen(fg, TRUE)
        /\ LET F == FenceOf(A, n, fg) IN
           /\ F # <<>> /\ F[2] = tgt
           /\ "fence-binds-incarnation" \in Fix => tep >= F[3]
           /\ LET N == IF "unfence-takes-epoch" \in Fix /\ tep > F[1][1]
                       THEN <<tep, F[1][2]>> ELSE F[1]
                  A2 == App(A, <<"unfenced", n, N>>)
              IN Go(Set(0, IF Named THEN A2 ELSE [A2 EXCEPT !.mem = <<>>]),
                    table, cl, net, started, recovered, maxpos)
  IN IF Named
     THEN /\ n \in DOMAIN mv /\ mv[n].tgt = tgt /\ ~mv[n].can /\ mv[n].unf = <<>> /\ ~mv[n].set
          /\ IF mv[n].N = <<>>
             THEN Go(Set(0, App(A, <<"cancel", n>>)), table, cl, net, started, recovered, maxpos)
             ELSE Unfence
     ELSE IF A.mem # <<>> /\ A.mem[1] = tgt /\ IsOpen(fg, TRUE)
          THEN Go(Set(0, [App(A, <<"cancel", NONE, tgt>>) EXCEPT !.mem = <<>>]),
                  table, cl, net, started, recovered, maxpos)
          ELSE Unfence

\* ---- the target, told of A's cancel, drops its copy
OnCancelled(m) ==
  LET tgt == m[2]
      n == m[3]
      sh == shards[tgt]
      lmv == TMoves(FG(sh))
  IN /\ n \in DOMAIN lmv /\ ~lmv[n].open /\ ~lmv[n].ab
     /\ Go(Set(tgt, App(sh, <<"abort", n>>)), table, cl, net, started, recovered, maxpos)

Deliver(m) ==
  CASE m[1] = "req" -> OnReq(m)
    [] m[1] = "export" -> OnExport(m)
    [] m[1] = "sub" -> OnSub(m)
    [] m[1] = "ready" -> OnReady(m) \/ OnReadySend(m)
    [] m[1] = "data" -> OnData(m)
    [] m[1] = "tw" -> OnTw(m)
    [] m[1] = "aborted" -> OnAborted(m)
    [] m[1] = "cancelled" -> OnCancelled(m)
    [] OTHER -> FALSE

\* ---- A cancels on its own, before its fence (a free choice)
ACancel ==
  LET A == shards[0]
      fg == FG(A)
  IN /\ ~calm
     /\ IF Named
        THEN LET mv == AMoves(fg) IN
             \E n \in DOMAIN mv :
               /\ mv[n].N = <<>> /\ ~mv[n].can /\ mv[n].unf = <<>>
               /\ Go(Set(0, App(A, <<"cancel", n>>)), table, cl, net, started, recovered, maxpos)
        ELSE /\ A.mem # <<>> /\ IsOpen(fg, TRUE)
             /\ Go(Set(0, [App(A, <<"cancel", NONE, A.mem[1]>>) EXCEPT !.mem = <<>>]),
                   table, cl, net, started, recovered, maxpos)

\* ---- mutant (d): A gives up after its fence without B's abort
AUnfenceAlone ==
  LET A == shards[0]
      le == FG(A)
      mv == AMoves(le)
  IN /\ ~calm /\ V = "a-unfences-alone"
     /\ \E n \in DOMAIN mv :
          /\ mv[n].N # <<>> /\ mv[n].unf = <<>> /\ ~IsOpen(le, TRUE)
          /\ Go(Set(0, App(App(A, <<"cancel", n>>), <<"unfenced", n, Top(le)>>)),
                table, cl, net, started, recovered, maxpos)

\* ---- mutant: A fences on its committed exporting alone
FenceWithoutReady ==
  /\ V = "fence-without-ready"
  /\ LET mv == AMoves(shards[0].com) IN
     \E n \in DOMAIN mv : TryFence(mv[n].tgt, n, Epoch(shards[mv[n].tgt].com))

\* ---- step 3: the target opens once its copy reaches END(N) and #meta has
\*      acked s -> target
TOpen(x) ==
  LET sh == shards[x]
      com == sh.com
      cm == TMoves(com)
      lm == TMoves(FG(sh))
      rg == TMoves(RG(sh))
  IN \E n \in DOMAIN cm :
       /\ n \in DOMAIN lm
       /\ cm[n].end # <<>> /\ cm[n].pos = cm[n].end
       /\ ~lm[n].open /\ ~rg[n].ab
       /\ V = "table-after-open"
          \/ <<"tack", x, Ver(n, 1, Epoch(Pre(com, cm[n].endi)), cm[n].endi + 1), x>> \in net
       /\ Go(Set(x, App(sh, <<"open", n, cm[n].end>>)), table, cl, net, started, recovered, maxpos)

\* ---- the target gives the move up (a free choice), only while it does not
\*      hold s open
TAbort(x) ==
  LET sh == shards[x]
      lm == TMoves(FG(sh))
      rg == TMoves(RG(sh))
      held == IsOpen(RG(sh), FALSE)
  IN /\ ~calm
     /\ \E n \in DOMAIN lm :
          LET rm == IF n \in DOMAIN rg THEN rg[n] ELSE lm[n] IN
          /\ ~lm[n].ab
          /\ (~rm.open /\ ~held) \/ V = "b-aborts-after-open"
          /\ Go(Set(x, App(sh, <<"abort", n>>)), table, cl, net, started, recovered, maxpos)

\* ---- Raft: the tail's first entry commits; answers waiting for it go out
Commit(x) ==
  LET sh == shards[x]
      e == Head(sh.tail)
      com2 == Append(sh.com, e)
      n == Len(com2)
      rel == {<<p[1], p[2], p[3], p[4]>> : p \in {p \in sh.pend : p[5] <= n}}
      sh2 == [com |-> com2, tail |-> Tail(sh.tail), dep |-> sh.dep,
              inh |-> IF sh.inh > 0 THEN sh.inh - 1 ELSE 0,
              lost |-> {},   \* once a leader commits, no lost tail returns
              pend |-> {p \in sh.pend : p[5] > n}, mem |-> sh.mem]
      fresh == Kind(e) # "w" \/ PLt(maxpos, e[3])
      nmax == IF Kind(e) = "w" /\ PLt(maxpos, e[3]) THEN e[3] ELSE maxpos
  IN /\ sh.tail # <<>>
     \* property 6, on the step: a committed write's position is above every
     \* position committed before it, anywhere
     /\ (~calm /\ ~fresh) => IF Soft THEN Fail(6, TLCGet("level"))
                               ELSE Assert(FALSE, "property 6 fails on a commit")
     /\ \E c2 \in (IF calm THEN {cl} ELSE Outcomes(cl, rel)) :
          Go(Set(x, sh2), table, c2, net, started, recovered, nmax)

\* ---- Raft: the leader is deposed; the new leader's tail is any prefix of
\*      the old tail or of a tail lost earlier and not overwritten since
NormLost(L, t) == {g \in L : g # <<>> /\ ~IsPrefix(g, t)
                             /\ ~\E h \in L : h # g /\ IsPrefix(g, h)}
Depose(x) ==
  LET sh == shards[x]
      cands == UNION {{SubSeq(g, 1, i) : i \in 0..Len(g)} : g \in {sh.tail} \cup sh.lost}
      lost2 == {g \in sh.lost \cup {sh.tail} : g # <<>>}
  IN /\ ~calm /\ ~recovered /\ sh.dep < D
     /\ \E c \in cands :
          Go(Set(x, [com |-> sh.com, tail |-> c, dep |-> sh.dep + 1,
                     inh |-> IF V = "stamp-from-committed" THEN Len(c) ELSE 0,
                     lost |-> NormLost(lost2, c), pend |-> {}, mem |-> <<>>]),
             table, cl, net, started, recovered, maxpos)

\* ---- fero recover --unclean x: a lagging copy (any prefix of the committed
\*      log) becomes the log; the epoch goes to 1; the recovery rule
\*      decides s; links are per incarnation, so messages to x are dropped
Addressee(m) ==
  CASE m[1] \in {"req", "export", "data", "cancelled"} -> m[2]
    [] m[1] \in {"sub", "ready", "aborted"} -> 0
    [] m[1] = "tack" -> m[4]
    [] OTHER -> NONE

Busy(sh, y) ==
  \/ IsOpen(FG(sh), y = 0) \/ IsOpen(sh.com, y = 0)
  \/ (y # 0 /\ LiveImport(FG(sh)))

\* fix 1: a recovered shard that does not reopen s ends its part in every
\* move of s: a target aborts its import; A cancels a move it has not fenced
EndMoves(log, x) ==
  IF x = 0
  THEN LET mv == AMoves(log)
           ns == {n \in DOMAIN mv : mv[n].N = <<>> /\ ~mv[n].can /\ mv[n].unf = <<>>}
       IN IF ns = {} THEN log
          ELSE IF Assert(Cardinality(ns) = 1, "two open exports")
               THEN Append(log, <<"cancel", CHOOSE n \in ns : TRUE>>) ELSE log
  ELSE LET mv == TMoves(log)
           ns == {n \in DOMAIN mv : ~mv[n].open /\ ~mv[n].ab}
       IN IF ns = {} THEN log
          ELSE IF Assert(Cardinality(ns) = 1, "two live imports")
               THEN Append(log, <<"abort", CHOOSE n \in ns : TRUE>>) ELSE log

Recover(x) ==
  LET sh == shards[x]
      net2 == {m \in net : Addressee(m) # x}
      others == V = "recovery-trusts-table" \/ \A y \in Sh \ {x} : ~Busy(shards[y], y)
  IN /\ ~calm /\ Rec /\ ~recovered
     /\ \E k \in 0..Len(sh.com) :
          LET pre == Pre(sh.com, k)
              mv == TMoves(pre)
              rows == x = 0 \/ IsOpen(pre, FALSE)
                      \/ \E n \in DOMAIN mv : mv[n].end # <<>> /\ mv[n].pos = mv[n].end /\ ~mv[n].ab
              ocs == {"shut"} \cup (IF table.h = x /\ rows /\ others THEN {"open"} ELSE {})
          IN \E oc \in ocs :
               LET log0 == Append(pre, <<"rec", oc>>)
                   log == IF oc = "shut" /\ "recovery-ends-move" \in Fix THEN EndMoves(log0, x) ELSE log0
                   nt == IF oc = "open" /\ "recovery-writes-table" \in Fix
                         THEN [h |-> x, v |-> RecVer] ELSE table
               IN Go(Set(x, [com |-> log, tail |-> <<>>, dep |-> sh.dep, inh |-> sh.inh,
                             lost |-> {}, pend |-> {}, mem |-> <<>>]),
                     nt, cl, net2, started, TRUE, maxpos)

-----------------------------------------------------------------------------
(* Liveness (property 7), as slot_move.py checks it: from every reachable  *)
(* state with no recovery, every message in flight is lost (the shards     *)
(* then repeat their reports; #meta's acks stay), the client goes idle, and *)
(* from then on no fault happens: no deposition, loss, recovery, new move, *)
(* cancel or abort. Some path must then end every move: AG EF Done. The    *)
(* Calm step enters that fault-free world; the graph is printed and        *)
(* tools/agef.py checks AG EF Done on it.                                  *)

Calm ==
  LET ps == [x \in Sh |-> [shards[x] EXCEPT !.dep = 0, !.inh = 0, !.lost = {}, !.pend = {}]]
      tacks == {m \in net : m[1] = "tack"}
  IN /\ WithCalm /\ ~calm /\ ~recovered
     /\ shards' = ps
     /\ table' = table
     /\ cl' = <<>>
     /\ net' = tacks \cup Reports(ps, tacks)
     /\ started' = M
     /\ recovered' = FALSE
     /\ maxpos' = Z
     /\ calm' = TRUE

\* No move left half done: every move a shard started has finished (the
\* target opened) or was cancelled or given back, at both ends.
Done ==
  LET A == shards[0] IN
  /\ IF Named
     THEN LET mv == AMoves(A.com) IN
          /\ \A n \in DOMAIN mv :
               \/ mv[n].can \/ mv[n].unf # <<>> \/ mv[n].set
               \/ LET tm == TMoves(shards[mv[n].tgt].com)
                  IN mv[n].N # <<>> /\ n \in DOMAIN tm /\ tm[n].open
          /\ Idx(A.tail, "exporting") = {}
     ELSE A.mem # <<>> =>
            LET F == FenceOf(A, NONE, A.com) IN
            F # <<>> /\ F[2] = A.mem[1] /\ IsOpen(shards[A.mem[1]].com, FALSE)
  /\ \A x \in Tg : ~LiveImport(FG(shards[x]))

FP(s) == <<TLCFP(s), TLCFP(<<s, 1>>)>>
StateNow == <<shards, table, cl, net, started, recovered, maxpos>>
StateNext == <<shards', table', cl', net', started', recovered', maxpos'>>

\* Printed once per calm state (as an invariant, checked once per new state).
CalmNode == calm => PrintT(<<"N", FP(StateNow), Done>>)

-----------------------------------------------------------------------------
Init ==
  LET sh0 == [x \in Sh |-> [com |-> <<>>, tail |-> <<>>, dep |-> 0, inh |-> 0,
                            lost |-> {}, pend |-> {}, mem |-> <<>>]]
  IN /\ shards = sh0
     /\ table = [h |-> 0, v |-> <<>>]
     /\ cl = [a \in 1..NW |-> [s |-> 0, q |-> <<>>, cp |-> 0]]
     /\ net = Reports(sh0, {})
     /\ started = 0
     /\ recovered = FALSE
     /\ maxpos = Z
     /\ calm = FALSE

Step ==
  \/ \E a \in 1..NW, d \in Sh : Issue(a, d) \/ Resend(a, d)
  \/ \E m \in net : Deliver(m)
  \/ \E tgt \in Tg : AExport(tgt)
  \/ ACancel
  \/ AUnfenceAlone
  \/ FenceWithoutReady
  \/ \E x \in Tg : TOpen(x) \/ TAbort(x)
  \/ \E x \in Sh : Commit(x)
  \/ \E x \in Sh : Depose(x) \/ Recover(x)

\* In the calm world each step is printed as an edge for tools/agef.py.
Next ==
  \/ ~calm /\ Step
  \/ calm /\ Step /\ PrintT(<<"E", FP(StateNow), FP(StateNext)>>)
  \/ Calm

Spec == Init /\ [][Next]_vars
=============================================================================
