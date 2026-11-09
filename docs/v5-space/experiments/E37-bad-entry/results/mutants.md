| mutant | verdict | by |
|---|---|---|
| `ParDetect:drop-update-bad:r01` | caught | ZLogInv on par1 (2 states in the trace) |
| `ZIgnore:drop-guard:r04` | undecided |  |
| `ZNormal:drop-guard:r02` | caught | ZMoreUpToDateCorrectInv on par1 (32 states in the trace) |
| `ZNormal:drop-guard:r03` | not caught |  |
| `ZRepair:drop-guard:r06` | not caught |  |
| `ZRepair:drop-guard:r07` | caught | ZLogInv on par2 (4 states in the trace) |
| `ZRepair:drop-guard:r08` | error |  |
| `ZRepair:drop-update-bad:r10` | caught | stuck with a live majority on par2d: 76 states (design: 0) |
| `ZRepair:drop-update-log:r09` | caught | ZLogInv on par1 (3 states in the trace) |
| `ZRepair:flip->=-to->:r08` | caught | stuck with a live majority on par2d: 14 states (design: 0) |
| `ZTimeout:drop-guard:r05` | caught | ZLogMatchingInv on par2d (56 states in the trace) |
