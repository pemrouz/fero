------------------------------- MODULE BagsExt -------------------------------
(***************************************************************************)
(* A local stand-in for the CommunityModules module of the same name: only *)
(* BagAdd and FoldBag, which etcd's etcdraft.tla uses. Written for fero's  *)
(* E-14. FoldBag applies op(acc, element) once per copy of each element:   *)
(* the only argument order under which etcdraft's PendingMessages, which   *)
(* calls BagAdd(x, y) on its first argument, is well typed.                *)
(***************************************************************************)
LOCAL INSTANCE Naturals
LOCAL INSTANCE Bags

\* B with one more copy of x.
BagAdd(B, x) ==
    IF x \in DOMAIN B
    THEN [e \in DOMAIN B |-> IF e = x THEN B[e] + 1 ELSE B[e]]
    ELSE [e \in DOMAIN B \cup {x} |-> IF e = x THEN 1 ELSE B[e]]

Rep(op(_, _), acc, x, n) ==
    LET R[k \in 0..n] == IF k = 0 THEN acc ELSE op(R[k - 1], x)
    IN  R[n]

RECURSIVE FoldOver(_, _, _, _)
FoldOver(op(_, _), acc, B, S) ==
    IF S = {} THEN acc
    ELSE LET x == CHOOSE y \in S : TRUE
         IN  FoldOver(op, Rep(op, acc, x, B[x]), B, S \ {x})

FoldBag(op(_, _), base, B) == FoldOver(op, base, B, DOMAIN B)
=============================================================================
