------------------------------ MODULE MCferog ------------------------------
(***************************************************************************)
(* E-14c: the same scenarios with one healing-order rule, "grow first".    *)
(* MCferoz.tla, unchanged, with one more guard on a leader's proposals,    *)
(* at every term. Written 2026-11-10.                                      *)
(*                                                                         *)
(* E-14b found that a group growing from two voters to three has a window: *)
(* if the leader is lost after the growth commits and before the other     *)
(* voter hears of it, the survivors wait for the old leader. E-14b's       *)
(* plans for the swap and for the lost-disk replacement let the leader     *)
(* take a voter away first and add the newcomer second, which passes       *)
(* through two voters and so through that window.                          *)
(*                                                                         *)
(* The rule here: a leader proposes a change that makes the voter set      *)
(* smaller only once every newcomer of the plan (the learner to promote,   *)
(* the spare to add) is a voter of the configuration the leader acts on.   *)
(* So a swap promotes and then demotes; a replacement adds and then        *)
(* removes; the group never has fewer voters than it started with.         *)
(* This changes which changes the leader proposes, never the membership    *)
(* rules: it is a rule for the planner (DESIGN-V5 4.2's healing).          *)
(***************************************************************************)
EXTENDS MCferoz

Newcomers == InitLearners \cup Joiners

\* A proposal step: reconfigCount goes up, and only the proposer's log grows.
GrowFirstOK ==
    reconfigCount' > reconfigCount =>
        LET i    == CHOOSE x \in Server : Len(log'[x]) > Len(log[x])
            newV == log'[i][Len(log'[i])].value.newconf
        IN  Cardinality(newV) < Cardinality(GetConfig(i)) => Newcomers \subseteq GetConfig(i)

GNext == ZNext /\ GrowFirstOK

GSpec == QInit /\ [][GNext]_<<allvars, planv, ctl, openv>>

=============================================================================
