---------------------------- MODULE SlotMoveFixed ----------------------------
(***************************************************************************)
(* The fixed protocol alone (slot_move.md's five fixes in force), for     *)
(* REQUIREMENTS DEV-10's mechanical mutants. It reuses SlotMove.tla's     *)
(* views of a log, its properties and its environment, and spells out     *)
(* the protocol's own rules once more, with no variant switches, one      *)
(* guard conjunct per line, and every protocol update that is not a       *)
(* plain step argument marked Upd(old, new). tools/mutants.py makes the   *)
(* mutants from the text between MUTATE-BEGIN and MUTATE-END; lines       *)
(* tagged "\* env" are bounds of the model, not rules, and are left alone. *)
(* SlotMoveFixed and SlotMove with V = "fixed" have the same state counts *)
(* on every bound (results/fixed-equiv.json).                             *)
(***************************************************************************)
EXTENDS Integers, Sequences, FiniteSets, TLC, TLCExt

CONSTANTS K, WSlots, W, R, D, M, Rec, WithCalm, Soft, UseCache
VARIABLES shards, table, cl, net, started, recovered, maxpos, calm
vars == <<shards, table, cl, net, started, recovered, maxpos, calm>>

FIXES == {"recovery-ends-move", "table-by-move", "unfence-takes-epoch",
          "recovery-writes-table", "fence-binds-incarnation"}
S == INSTANCE SlotMove WITH V <- "fixed", Fix <- FIXES

\* SlotMove's views, used as they are
Sh == S!Sh
Tg == S!Tg
NW == S!NW
Z == S!Z
PLt(p, q) == S!PLt(p, q)
PLe(p, q) == S!PLe(p, q)
VLt(a, b) == S!VLt(a, b)
Kind(e) == S!Kind(e)
Pre(es, n) == S!Pre(es, n)
IsOpen(es, isA) == S!IsOpen(es, isA)
Epoch(es) == S!Epoch(es)
Top(es) == S!Top(es)
WritesOf(es) == S!WritesOf(es)
AMoves(es) == S!AMoves(es)
TMoves(es) == S!TMoves(es)
Dedup(es) == S!Dedup(es)
Floor(hi) == S!Floor(hi)
WSlot(a) == S!WSlot(a)
Dsts(a) == S!Dsts(a)
FG(sh) == S!FG(sh)
Idx(es, k) == S!Idx(es, k)
Outcomes(c, rel) == S!Outcomes(c, rel)
Answer(sh, a, cp, kind, pos, wait) == S!Answer(sh, a, cp, kind, pos, wait)
Prune(sh, c) == S!Prune(sh, c)
Addressee(m) == S!Addressee(m)
NormLost(L, t) == S!NormLost(L, t)
Fail(p, steps) == S!Fail(p, steps)
FP(s) == S!FP(s)
StateNow == S!StateNow
StateNext == S!StateNext

\* a protocol update the mutation tool may drop (mutant: keep `old`)
Upd(old, new) == new
VLe(a, b) == a = b \/ VLt(a, b)

\* MUTATE-BEGIN ---------------------------------------------------------------

\* Does shard x take writes to s?
Serving(sh, x) ==
  /\ IsOpen(sh.com, x = 0)
  /\ IsOpen(FG(sh), x = 0)

\* 2: a leader stamps on from its log end, in its epoch
NextPos(sh, x) ==
  LET le == sh.com \o sh.tail
      p == Top(le)
      ep == IF Epoch(le) > p[1] THEN Epoch(le) ELSE p[1]
  IN <<ep, p[2] + 1>>

Judge(es, a) ==
  LET d == Dedup(es)
      fl == Floor(d.hi)
  IN IF /\ a \in DOMAIN d.out
        /\ a > fl
     THEN [r |-> "hit", kind |-> d.out[a][1], pos |-> d.out[a][2], wait |-> d.out[a][3]]
     ELSE IF a <= fl THEN [r |-> "stale", wait |-> d.hw]
     ELSE [r |-> "fresh"]

\* the carried state: the outcomes tagged with s above the floor, and the
\* issuer's highest call id
Carried(es) ==
  LET d == Dedup(es)
      fl == Floor(d.hi)
  IN <<{<<a, d.out[a][1], d.out[a][2]>> : a \in {b \in DOMAIN d.out : /\ WSlot(b) = "s"
                                                                      /\ b > fl}},
       d.hi>>

LiveImport(es) ==
  LET mv == TMoves(es) IN
  \E n \in DOMAIN mv : /\ ~mv[n].open
                       /\ ~mv[n].ab

UnderWay(es) ==
  LET mv == AMoves(es) IN
  \E n \in DOMAIN mv : /\ ~mv[n].can
                       /\ mv[n].unf = <<>>

AReports(A) ==
  LET mv == AMoves(A.com) IN
  {<<"cancelled", mv[n].tgt, n>> : n \in {k \in DOMAIN mv : mv[k].can}}
  \cup {<<"export", mv[n].tgt, n>> : n \in {k \in DOMAIN mv : /\ ~mv[k].can
                                                              /\ mv[k].unf = <<>>
                                                              /\ ~mv[k].set}}

TRep(x, n, m, com, ep, nt) ==
  LET vr == <<0, n, Epoch(Pre(com, m.abi)), 2>>
  IN \* importing: ask A for s's records
     (IF /\ ~m.open
         /\ ~m.ab
         /\ m.end = <<>>
      THEN {<<"sub", x, n>>} ELSE {})
     \* S1: ready, once a copy is committed, with the position it reached
     \cup (IF /\ ~m.open
              /\ ~m.ab
              /\ m.end = <<>>
              /\ m.seen
           THEN {<<"ready", x, n, m.pos, ep>>} ELSE {})
     \* C1: with END(N) committed, write s -> x into the table
     \cup (IF /\ ~m.open
              /\ ~m.ab
              /\ m.end # <<>>
           THEN {<<"tw", x, <<0, n, Epoch(Pre(com, m.endi)), 1>>, x>>} ELSE {})
     \* fix 2: on an abort, always write s -> A back
     \cup (IF /\ ~m.open
              /\ m.ab
           THEN {<<"tw", 0, vr, x>>} ELSE {})
     \* then, once #meta has acked it, report the abort with x's epoch
     \cup (IF /\ ~m.open
              /\ m.ab
              /\ <<"tack", 0, vr, x>> \in nt
           THEN {<<"aborted", x, n, ep>>} ELSE {})

TReports(x, sh, nt) ==
  LET com == sh.com
      mv == TMoves(com)
  IN UNION {TRep(x, n, mv[n], com, Epoch(com), nt) : n \in DOMAIN mv}

Reports(sh, nt) == AReports(sh[0]) \cup UNION {TReports(x, sh[x], nt) : x \in Tg}

\* MUTATE-PAUSE (the step machinery: not a rule)
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
\* MUTATE-RESUME

OnReq(m) ==
  LET d == m[2]
      a == m[3]
      cp == m[4]
      sh == shards[d]
      le == FG(sh)
      j == Judge(le, a)
      pos == NextPos(sh, d)
      res == CASE j.r = "hit" -> Answer(sh, a, cp, j.kind, j.pos, j.wait)
               [] j.r = "stale" -> Answer(sh, a, cp, "stale", <<>>, j.wait)
               [] OTHER -> IF WSlot(a) = "s"
                           THEN Answer(Upd(sh, App(sh, <<"w", a, pos>>)), a, cp, "ok", pos, Len(le) + 1)
                           ELSE Answer(Upd(sh, App(sh, <<"wt", a>>)), a, cp, "ok", <<>>, Len(le) + 1)
  IN /\ ~calm                                                       \* env
     /\ \/ WSlot(a) = "t"
        \/ Serving(sh, d)
     /\ \E c2 \in Outcomes(cl, res.rel) :
          Go(Set(d, res.sh), table, c2, net, started, recovered, maxpos)

\* step 0
AExport(tgt) ==
  LET A == shards[0] IN
  /\ ~calm                                                          \* env
  /\ started < M                                                    \* env
  /\ IsOpen(FG(A), TRUE)
  /\ IsOpen(A.com, TRUE)
  /\ ~UnderWay(FG(A))
  /\ Go(Set(0, App(A, <<"exporting", tgt>>)), table, cl, net, started + 1, recovered, maxpos)

\* step 1
OnExport(m) ==
  LET tgt == m[2]
      n == m[3]
      sh == shards[tgt]
      fg == FG(sh)
  IN /\ ~LiveImport(fg)
     /\ ~IsOpen(fg, FALSE)
     /\ n \notin DOMAIN TMoves(fg)
     /\ Go(Set(tgt, App(sh, <<"importing", n>>)), table, cl, net, started, recovered, maxpos)

OnSub(m) ==
  LET tgt == m[2]
      n == m[3]
      A == shards[0]
      mv == AMoves(A.com)
      d == <<"data", tgt, n, <<>>, Top(A.com), WritesOf(A.com), <<>>, <<>>>>
  IN /\ n \in DOMAIN mv
     /\ mv[n].tgt = tgt
     /\ mv[n].N = <<>>
     /\ ~mv[n].can
     /\ mv[n].unf = <<>>
     /\ IsOpen(A.com, TRUE)
     /\ d \notin net                                                \* env
     /\ Go(shards, table, cl, net \cup {d}, started, recovered, maxpos)

\* step 2
OnReady(m) ==
  LET tgt == m[2]
      n == m[3]
      tep == m[5]
      A == shards[0]
      fg == FG(A)
      cmv == AMoves(A.com)
      lm == AMoves(fg)[n]
      N0 == Top(fg)
      N == IF N0[1] < Epoch(fg) THEN <<Epoch(fg), N0[2]>> ELSE N0
  IN /\ n \in DOMAIN cmv
     /\ cmv[n].tgt = tgt
     /\ lm.N = <<>>
     /\ ~lm.can
     /\ lm.unf = <<>>
     /\ IsOpen(fg, TRUE)
     /\ IsOpen(A.com, TRUE)
     /\ Go(Set(0, App(A, <<"fenced", n, N, tgt, tep>>)), table, cl, net, started, recovered, maxpos)

FenceOf(A, n, src) ==
  LET mv == AMoves(src) IN
  IF /\ n \in DOMAIN mv
     /\ mv[n].N # <<>>
     /\ mv[n].unf = <<>>
     /\ ~mv[n].can
     /\ ~mv[n].set
  THEN <<mv[n].N, mv[n].tgt, mv[n].tep>> ELSE <<>>

OnReadySend(m) ==
  LET tgt == m[2]
      n == m[3]
      p == m[4]
      A == shards[0]
      F == FenceOf(A, n, A.com)
      ws == {w \in WritesOf(A.com) : /\ PLt(p, w[2])
                                     /\ PLe(w[2], F[1])}
      d == <<"data", tgt, n, p, F[1], ws, F[1], Append(Carried(A.com), F[3])>>
  IN /\ F # <<>>
     /\ F[2] = tgt
     /\ ~PLt(F[1], p)
     /\ d \notin net                                                \* env
     /\ Go(shards, table, cl, net \cup {d}, started, recovered, maxpos)

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
      pos == lmv[n].pos
      Do(c2) == LET top == IF PLt(pos, q) THEN q ELSE pos
                    e == <<"imp", n, top, {w \in ws : PLt(pos, w[2])}, end, c2>>
                IN Go(Set(tgt, App(sh, e)), table, cl, net, started, recovered, maxpos)
  IN /\ n \in DOMAIN cm
     /\ n \in DOMAIN lmv
     /\ ~lmv[n].open
     /\ ~lmv[n].ab
     /\ lmv[n].end = <<>>
     /\ IF p = <<>>
        THEN /\ ~(/\ lmv[n].seen
                  /\ PLe(q, pos))
             /\ Do(car)
        ELSE /\ ~PLt(pos, p)
             /\ \/ PLt(pos, q)
                \/ end # <<>>
             /\ car[3] = Epoch(FG(sh))
             /\ Do(<<car[1], car[2]>>)

OnTw(m) ==
  LET val == m[2]
      ver == m[3]
      ack == <<"tack", val, ver, m[4]>>
  IN /\ ~VLt(ver, table.v)
     /\ ~(/\ ver = table.v
          /\ val # table.h)
     /\ ~(ver = table.v /\ ack \in net)                             \* env
     /\ Go(shards, [h |-> val, v |-> ver], cl, net \cup {ack}, started, recovered, maxpos)

OnAborted(m) ==
  LET tgt == m[2]
      n == m[3]
      tep == m[4]
      A == shards[0]
      fg == FG(A)
      mv == AMoves(fg)
      F == FenceOf(A, n, fg)
      N == Upd(F[1], IF tep > F[1][1] THEN <<tep, F[1][2]>> ELSE F[1])
  IN /\ n \in DOMAIN mv
     /\ mv[n].tgt = tgt
     /\ ~mv[n].can
     /\ mv[n].unf = <<>>
     /\ ~mv[n].set
     /\ \/ /\ mv[n].N = <<>>
           /\ Go(Set(0, App(A, <<"cancel", n>>)), table, cl, net, started, recovered, maxpos)
        \/ /\ mv[n].N # <<>>
           /\ ~IsOpen(fg, TRUE)
           /\ F # <<>>
           /\ F[2] = tgt
           /\ tep >= F[3]
           /\ Go(Set(0, App(A, <<"unfenced", n, N>>)), table, cl, net, started, recovered, maxpos)

OnCancelled(m) ==
  LET tgt == m[2]
      n == m[3]
      sh == shards[tgt]
      lmv == TMoves(FG(sh))
  IN /\ n \in DOMAIN lmv
     /\ ~lmv[n].open
     /\ ~lmv[n].ab
     /\ Go(Set(tgt, App(sh, <<"abort", n>>)), table, cl, net, started, recovered, maxpos)

ACancel ==
  LET A == shards[0]
      mv == AMoves(FG(A))
  IN /\ ~calm                                                       \* env
     /\ \E n \in DOMAIN mv :
          /\ mv[n].N = <<>>
          /\ ~mv[n].can
          /\ mv[n].unf = <<>>
          /\ Go(Set(0, App(A, <<"cancel", n>>)), table, cl, net, started, recovered, maxpos)

\* step 3
TOpen(x) ==
  LET sh == shards[x]
      com == sh.com
      cm == TMoves(com)
      lm == TMoves(FG(sh))
  IN \E n \in DOMAIN cm :
       /\ n \in DOMAIN lm
       /\ cm[n].end # <<>>
       /\ cm[n].pos = cm[n].end
       /\ ~lm[n].open
       /\ ~lm[n].ab
       /\ <<"tack", x, <<0, n, Epoch(Pre(com, cm[n].endi)), 1>>, x>> \in net
       /\ Go(Set(x, App(sh, <<"open", n, cm[n].end>>)), table, cl, net, started, recovered, maxpos)

TAbort(x) ==
  LET sh == shards[x]
      lm == TMoves(FG(sh))
  IN /\ ~calm                                                       \* env
     /\ \E n \in DOMAIN lm :
          /\ ~lm[n].ab
          /\ ~lm[n].open
          /\ ~IsOpen(FG(sh), FALSE)
          /\ Go(Set(x, App(sh, <<"abort", n>>)), table, cl, net, started, recovered, maxpos)

Busy(sh, y) ==
  \/ IsOpen(FG(sh), y = 0)
  \/ IsOpen(sh.com, y = 0)
  \/ /\ y # 0
     /\ LiveImport(FG(sh))

\* fix 1
EndMoves(log, x) ==
  IF x = 0
  THEN LET mv == AMoves(log)
           ns == {n \in DOMAIN mv : /\ mv[n].N = <<>>
                                    /\ ~mv[n].can
                                    /\ mv[n].unf = <<>>}
       IN IF ns = {} THEN log ELSE Append(log, <<"cancel", CHOOSE n \in ns : TRUE>>)
  ELSE LET mv == TMoves(log)
           ns == {n \in DOMAIN mv : /\ ~mv[n].open
                                    /\ ~mv[n].ab}
       IN IF ns = {} THEN log ELSE Append(log, <<"abort", CHOOSE n \in ns : TRUE>>)

Recover(x) ==
  LET sh == shards[x]
      net2 == Upd(net, {m \in net : Addressee(m) # x})
      others == \A y \in Sh \ {x} : ~Busy(shards[y], y)
      New(log) == [com |-> log, tail |-> <<>>, dep |-> sh.dep, inh |-> sh.inh,
                   lost |-> {}, pend |-> {}, mem |-> <<>>]
  IN /\ ~calm                                                       \* env
     /\ Rec                                                         \* env
     /\ ~recovered                                                  \* env
     /\ \E k \in 0..Len(sh.com) :
          LET pre == Pre(sh.com, k)
              mv == TMoves(pre)
              shut == Append(pre, <<"rec", "shut">>)
              rows == \/ x = 0
                      \/ IsOpen(pre, FALSE)
                      \/ \E n \in DOMAIN mv : /\ mv[n].end # <<>>
                                              /\ mv[n].pos = mv[n].end
                                              /\ ~mv[n].ab
          IN \/ Go(Set(x, New(Upd(shut, EndMoves(shut, x)))), table, cl, net2, started, TRUE, maxpos)
             \/ /\ table.h = x
                /\ rows
                /\ others
                /\ Go(Set(x, New(Append(pre, <<"rec", "open">>))),
                      Upd(table, [h |-> x, v |-> <<1, -1, 0, 0>>]), cl, net2, started, TRUE, maxpos)

\* MUTATE-END -----------------------------------------------------------------

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

\* The environment, as in SlotMove (the client and the Raft groups)
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

Commit(x) ==
  LET sh == shards[x]
      e == Head(sh.tail)
      com2 == Append(sh.com, e)
      n == Len(com2)
      rel == {<<p[1], p[2], p[3], p[4]>> : p \in {p \in sh.pend : p[5] <= n}}
      sh2 == [com |-> com2, tail |-> Tail(sh.tail), dep |-> sh.dep,
              inh |-> IF sh.inh > 0 THEN sh.inh - 1 ELSE 0,
              lost |-> {}, pend |-> {p \in sh.pend : p[5] > n}, mem |-> sh.mem]
      fresh == Kind(e) # "w" \/ PLt(maxpos, e[3])
      nmax == IF Kind(e) = "w" /\ PLt(maxpos, e[3]) THEN e[3] ELSE maxpos
  IN /\ sh.tail # <<>>
     /\ (~calm /\ ~fresh) => IF Soft THEN Fail(6, TLCGet("level"))
                               ELSE Assert(FALSE, "property 6 fails on a commit")
     /\ \E c2 \in (IF calm THEN {cl} ELSE Outcomes(cl, rel)) :
          Go(Set(x, sh2), table, c2, net, started, recovered, nmax)

Depose(x) ==
  LET sh == shards[x]
      cands == UNION {{SubSeq(g, 1, i) : i \in 0..Len(g)} : g \in {sh.tail} \cup sh.lost}
      lost2 == {g \in sh.lost \cup {sh.tail} : g # <<>>}
  IN /\ ~calm /\ ~recovered /\ sh.dep < D
     /\ \E c \in cands :
          Go(Set(x, [com |-> sh.com, tail |-> c, dep |-> sh.dep + 1, inh |-> 0,
                     lost |-> NormLost(lost2, c), pend |-> {}, mem |-> <<>>]),
             table, cl, net, started, recovered, maxpos)

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

Done == S!Done
CalmNode == calm => PrintT(<<"N", FP(StateNow), Done>>)
SoftInv == S!SoftInv
Inv1 == S!Inv1
Inv2 == S!Inv2
Inv3 == S!Inv3
Inv4 == S!Inv4
Inv5 == S!Inv5
Inv6 == S!Inv6
Inv8 == S!Inv8
Inv9 == S!Inv9

Init ==
  /\ S!Init
  /\ net = Reports(shards, {})

Step ==
  \/ \E a \in 1..NW, d \in Sh : Issue(a, d) \/ Resend(a, d)
  \/ \E m \in net : Deliver(m)
  \/ \E tgt \in Tg : AExport(tgt)
  \/ ACancel
  \/ \E x \in Tg : TOpen(x) \/ TAbort(x)
  \/ \E x \in Sh : Commit(x)
  \/ \E x \in Sh : Depose(x) \/ Recover(x)

Next ==
  \/ ~calm /\ Step
  \/ calm /\ Step /\ PrintT(<<"E", FP(StateNow), FP(StateNext)>>)
  \/ Calm
=============================================================================
