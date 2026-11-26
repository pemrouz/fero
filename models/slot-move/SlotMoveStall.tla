------------------------- MODULE SlotMoveStall -------------------------
(* The stall check's side of SlotMove.  It adds one variable, obs, that is
   a function of the others, so the state graph is the same.  TLC prints
   the graph with obs in every state; stall.py reads it. *)
EXTENDS SlotMove

VARIABLE obs

Obs == <<AllIn,                              \* every write has committed
         up["A"] /\ up["B"],                 \* both data groups have a majority
         up["H"],                            \* the home group has one
         Table(CL("H")).own \in Server>>     \* the table names the server

SInit == Init /\ obs = Obs
O == obs' = Obs'
S_Take == (\E g \in DG, s \in S : Take(g, s)) /\ O
S_StartMove == (\E g \in DG : StartMove(g)) /\ O
S_Copy == (\E g \in DG : Copy(g)) /\ O
S_Fence == (\E g \in DG : Fence(g)) /\ O
S_Final == (\E g \in DG : Final(g)) /\ O
S_Abort == (\E g \in DG : Abort(g)) /\ O
S_Back == (\E g \in DG : Back(g)) /\ O
S_Unfence == (\E g \in DG : Unfence(g)) /\ O
S_Reconf == (\E g \in DG : Reconf(g)) /\ O
S_Commit == (\E g \in G : Commit(g)) /\ O
S_Crash == (\E g \in G : Crash(g)) /\ O
S_Revive == (\E g \in G : Revive(g)) /\ O
S_Down == (\E g \in G : Down(g)) /\ O
S_Up == (\E g \in G : Up(g)) /\ O
S_Ask == (\E g \in DG : Ask(g)) /\ O
S_StaleRoute == StaleRoute /\ O
SNext == S_Take \/ S_StartMove \/ S_Copy \/ S_Fence \/ S_Final \/ S_Abort \/ S_Back \/ S_Unfence \/ S_Reconf \/ S_Commit \/ S_Crash \/ S_Revive \/ S_Down \/ S_Up \/ S_Ask \/ S_StaleRoute
SSpec == SInit /\ [][SNext]_<<vars, obs>>
=============================================================================
