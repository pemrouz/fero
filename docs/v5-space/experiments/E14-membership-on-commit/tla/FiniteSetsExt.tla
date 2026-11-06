---------------------------- MODULE FiniteSetsExt ---------------------------
(***************************************************************************)
(* A local stand-in for the CommunityModules module of the same name: only *)
(* Max and Min, which etcd's etcdraft.tla uses. Written for fero's E-14.   *)
(***************************************************************************)
LOCAL INSTANCE Naturals

Max(S) == CHOOSE x \in S : \A y \in S : y <= x
Min(S) == CHOOSE x \in S : \A y \in S : x <= y
=============================================================================
