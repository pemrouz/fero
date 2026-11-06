---------------------------- MODULE SequencesExt ----------------------------
(***************************************************************************)
(* A local stand-in for the TLA+ CommunityModules module of the same name. *)
(* It defines only the operators etcd's etcdraft.tla and MCetcdraft.tla   *)
(* use, in plain TLA+ (no Java overrides), so the shipped spec runs with   *)
(* tla2tools.jar alone. Written for fero's E-14, 2026-11-06.               *)
(***************************************************************************)
LOCAL INSTANCE Sequences
LOCAL INSTANCE Naturals
LOCAL INSTANCE FiniteSets

\* s is a prefix of t.
IsPrefix(s, t) ==
    /\ Len(s) <= Len(t)
    /\ SubSeq(s, 1, Len(s)) = SubSeq(t, 1, Len(s))

\* Some sequence holding each element of the finite set S once.
SetToSeq(S) ==
    CHOOSE f \in [1..Cardinality(S) -> S] :
        \A i, j \in 1..Cardinality(S) : f[i] = f[j] => i = j

\* Folds op over seq from its first element to its last: op(element, acc).
\* (MCetcdraft uses op as LAMBDA element, accumulator.)
FoldSeq(op(_, _), base, seq) ==
    LET F[k \in 0..Len(seq)] == IF k = 0 THEN base ELSE op(seq[k], F[k - 1])
    IN  F[Len(seq)]

\* The index (into s) of the last element of s[from..to] that satisfies
\* Test, or 0 if there is none.
SelectLastInSubSeq(s, from, to, Test(_)) ==
    LET I == {k \in from..to : k \in 1..Len(s) /\ Test(s[k])}
    IN  IF I = {} THEN 0 ELSE CHOOSE k \in I : \A l \in I : l <= k
=============================================================================
