# DEV-10 mutants of E-14's membership rules, by exhaustive search on MCferolive.tla
#   scenarios: m3 = three {"AllowDrop": false, "AllowStepDown": false, "FaultLimit": 0, "LeaderLease": true, "MaxTermLimit": 4, "Plan": "all", "ReconfigurationLimit": 1}; m2 = two {"AllowDrop": false, "AllowStepDown": false, "FaultLimit": 0, "LeaderLease": true, "MaxTermLimit": 4, "Plan": "all", "ReconfigurationLimit": 2}; m2p = two {"AllowDrop": false, "AllowStepDown": false, "FaultLimit": 0, "LeaderLease": true, "MaxTermLimit": 4, "Plan": "stepback", "ReconfigurationLimit": 1}; m3c = three {"AllowDrop": false, "AllowStepDown": false, "CrashLeaderOnly": true, "FaultLimit": 1, "LeaderLease": true, "MaxTermLimit": 4, "Plan": "all", "ReconfigurationLimit": 1}; m4c = four-voters {"AllowDrop": false, "AllowStepDown": false, "CrashLeaderOnly": true, "FaultLimit": 1, "LeaderLease": true, "MaxTermLimit": 4, "Plan": "demote", "ReconfigurationLimit": 1}
#   design: {"m2": {"agef": "PASS", "complete": true, "distinct": 100736, "error": null, "plan": "PASS", "plan_stuck": 0, "secs": 108, "stuck_live": 0, "violated": null}, "m2p": {"agef": "PASS", "complete": true, "distinct": 572, "error": null, "plan": "PASS", "plan_stuck": 0, "secs": 3, "stuck_live": 0, "violated": null}, "m3": {"agef": "PASS", "complete": true, "distinct": 12098, "error": null, "plan": "PASS", "plan_stuck": 0, "secs": 24, "stuck_live": 0, "violated": null}, "m3c": {"agef": "PASS", "complete": true, "distinct": 500230, "error": null, "plan": "PASS", "plan_stuck": 0, "secs": 486, "stuck_live": 0, "violated": null}, "m4c": {"agef": null, "complete": false, "distinct": 691952, "error": null, "plan": null, "plan_stuck": null, "secs": 903, "stuck_live": null, "violated": null}}

| mutant | rule | verdict | how | states per scenario |
|---|---|---|---|---|
| FeroBecomeLeader:drop-guard:r01 | `/\ votesGranted[i] \cap GetConfig(i) \in Quorum(GetConfig(i))` | caught | m3: MoreUpToDateCorrectInv | m2 skipped, m3 891 |
| FeroBecomeLeader:drop-update-pendingConfChangeIndex:r02 | `/\ pendingConfChangeIndex' = [pendingConfChangeIndex EXCEPT ![i] = Len(log[i])]` | caught | m2: QuorumLogInvLive | m2 48753, m3 12098 |
| FeroBecomeLeader:drop-update-log:r03 | `/\ log' = [log EXCEPT ![i] = Append(@, [term \|-> currentTerm[i], type \|-> ValueEntry, value \|-> Noop])]` | caught | m3: stuck with a live majority (416 states) | m2 skipped, m3 5698 |
| ProposeConf:drop-guard:r04 | `/\ state[i] = Leader` | caught | m3: ElectionSafetyInv | m2 skipped, m3 7 |
| ProposeConf:drop-guard:r05 | `/\ pendingConfChangeIndex[i] <= commitIndex[i]` | caught | m2: QuorumLogInvLive | m2 15779, m3 12098 |
| ProposeConf:flip-<=-to-<:r05 | `/\ pendingConfChangeIndex[i] <= commitIndex[i]` | not caught |  | m2 38444, m2p 572, m3 12098, m3c 432680 |
| ProposeConf:drop-guard:r06 | `/\ ConfApplied(i)` | caught | m2: QuorumLogInvLive | m2 4557, m3 12098 |
| ProposeConf:drop-guard:r07 | `/\ newVoters # {}` | not caught |  | m2 124952, m2p 572, m3 12098, m3c 500230 |
| ProposeConf:drop-update-log:r08 | `/\ log' = [log EXCEPT ![i] = Append(@, [term \|-> currentTerm[i], type \|-> ConfigEntry, value \|-> [newconf \|-> newVoters, learners \|-> newLearners]])]` | caught | m2p: plan cannot finish (40 states) | m2 60, m2p 40, m3 40, m3c skipped |
| ProposeConf:drop-update-pendingConfChangeIndex:r09 | `/\ pendingConfChangeIndex' = [pendingConfChangeIndex EXCEPT ![i] = Len(log'[i])]` | caught | m2: QuorumLogInvLive | m2 17365, m3 12098 |
| AddLearnerF:drop-guard:r10 | `/\ j \notin GetConfig(i) \cup GetLearners(i)` | not caught |  | m2 183717, m2p 572, m3 13526, m3c 642511 |
| AddVoterF:drop-guard:r11 | `/\ j \notin GetConfig(i) \cup GetLearners(i)` | not caught |  | m2 186253, m2p 572, m3 12312, m3c 521873 |
| PromoteF:drop-guard:r12 | `/\ j \in GetLearners(i)` | not caught |  | m2 121609, m2p 572, m3 12312, m3c 521873 |
| DemoteF:drop-guard:r13 | `/\ j \in GetConfig(i)` | not caught |  | m2 120011, m2p 572, m3 12098, m3c 500230 |
| RemoveF:drop-guard:r14 | `/\ j \in GetConfig(i) \cup GetLearners(i)` | not finished |  | m2 102930, m2p None (not finished), m3 12098, m3c None (not finished) |
| FeroApplyConf:drop-guard:r15 | `/\ LastConfIdx(log[i], commitIndex[i]) > 0` | not run | | |
| FeroApplyConf:flip->-to->=:r15 | `/\ LastConfIdx(log[i], commitIndex[i]) > 0` | not run | | |
| FeroApplyConf:drop-guard:r16 | `/\ ~ConfApplied(i)` | not run | | |
| FeroApplyConf:drop-update-config:r17 | `/\ config' = [config EXCEPT ![i] = CommittedConf(i)]` | caught | m3: stuck with a live majority (628 states) | m2 skipped, m2p skipped, m3 5376, m3c skipped |
| FeroApplyConf:drop-update-state:r18 | `/\ state' = [state EXCEPT ![i] = IF state[i] = Leader /\ i \notin CommittedConf(i).jointConfig[1] THEN Follower ELSE state[i]]` | caught | m3: stuck with a live majority (728 states) | m2 skipped, m2p skipped, m3 2776, m3c skipped |
| CanCampaign:drop-guard:r19 | `/\ i \in GetConfig(i)` | not finished |  | m2 1493456 (not finished), m2p 572, m3 50667, m3c 703683 (not finished) |
| CanCampaign:drop-guard:r20 | `/\ ConfApplied(i)` | not run | | |

18 mutants run: 10 caught
