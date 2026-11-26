---------------------------- MODULE HomeRecordsLive ----------------------------
(* The same model with one more variable, a tag: is this state a goal, is
   it judged, and was the step into it a calm one.  TLC writes the whole
   state graph; agef.py then checks "from every judged state, calm steps
   alone can reach a goal".  The tag changes nothing else. *)
EXTENDS HomeRecords
VARIABLE tag
LInit == Init /\ tag = <<Goal, Judged, "start">>
LNext == \/ Calm /\ tag' = <<Goal', Judged', "calm">>
         \/ Rough /\ tag' = <<Goal', Judged', "rough">>
LSpec == LInit /\ [][LNext]_<<vars, tag>>
=============================================================================
