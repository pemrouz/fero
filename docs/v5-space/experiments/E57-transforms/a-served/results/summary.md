# E-57 group A: tables from the raw lines

Made by `node summarize.mjs` from `results/*.jsonl`. Every seeded line ran once under the heavy lock (a seed gives the same line every time).

## Seeded runs (no planted bug)

| run | seeds | seeds failed | why | counters (non-zero) |
|---|---|---|---|---|
| a1 | 1000 | 0 | {} | checks 144843, framesApplied 131974, clientPictures 12869, xa6Checks 68296, admits 9683, lingerReuses 217, pictureBytes 8066383, frames 119632, frameBytes 12501537, encodes 119632, sends 141366, waits 4643 |
| a2 | 1000 | 0 | {} | checks 102032, framesApplied 80595, clientPictures 15271, disconnects 12870, clientRingResumes 6166, resumePictures 5909, kills 1090, leaderKills 421, xa6Checks 47729, admits 12748, buildsOnSnapshot 3354, lingerReuses 6693, ringResumes 6814, ringFrames 7132, resumeBytes 1023043, pictureBytes 9717770, frames 86024, frameBytes 8763496, encodes 86024, sends 85909, waits 6636 |
| a3 | 1000 | 0 | {} | checks 77828, framesApplied 54562, clientPictures 22040, disconnects 10002, clientRingResumes 1226, resumePictures 13360, kills 5371, leaderKills 2413, xa6Checks 37076, admits 20582, buildsOnSnapshot 16139, lingerReuses 1602, ringResumes 1345, ringFrames 1327, resumeBytes 192423, pictureBytes 13619185, frames 65328, frameBytes 6578261, encodes 65328, sends 65869, waits 6045 |
| a4 | 1000 | 0 | {} | checks 53662, framesApplied 33972, clientPictures 16087, disconnects 11333, clientRingResumes 3603, resumePictures 8630, kills 3038, leaderKills 615, xa6Checks 14273, denied 3188, admits 15889, buildsOnSnapshot 9280, lingerReuses 4278, ringResumes 3880, ringFrames 2209, resumeBytes 362135, pictureBytes 3997673, frames 38216, frameBytes 2745268, encodes 38216, sends 35411, waits 5512 |
| a5 | 1000 | 0 | {} | checks 72904, framesApplied 52813, clientPictures 17515, disconnects 12441, clientRingResumes 2576, resumePictures 8999, kills 3642, leaderKills 1183, xa6Checks 44898, admits 28211, refusedCap 4840, refusedHeld 1000, tooBig 1139, warn80 28087, getsChecked 5126, buildsOnSnapshot 13530, lingerReuses 3553, ringResumes 2794, ringFrames 2587, resumeBytes 402862, pictureBytes 14832193, frames 69655, frameBytes 7320163, encodes 69655, sends 58524, waits 3872 |
| a6 | 1000 | 0 | {} | checks 69119, framesApplied 51007, clientPictures 15718, disconnects 11591, clientRingResumes 2394, resumePictures 7406, kills 3104, leaderKills 1227, xa6Checks 32010, admits 18609, calls 3559, getsChecked 5175, buildsOnSnapshot 9316, lingerReuses 3124, ringResumes 2643, ringFrames 2519, resumeBytes 371409, pictureBytes 12601353, frames 64085, frameBytes 6407606, encodes 64085, sends 59479, waits 4442 |
| a7 | 1000 | 0 | {} | checks 79209, framesApplied 53337, clientPictures 20428, disconnects 12683, clientRingResumes 5444, resumePictures 9428, kills 1831, leaderKills 378, fallbacks 4554, buildsOnSnapshot 7533, lingerReuses 6954, ringResumes 6092, ringFrames 4516, resumeBytes 884916, pictureBytes 17020666, frames 54562, frameBytes 6742694, encodes 54562, sends 51233, waits 7658 |
| a8 | 1000 | 0 | {} | checks 90566, framesApplied 67357, clientPictures 19935, disconnects 10846, clientRingResumes 3274, resumePictures 11054, kills 3059, leaderKills 1258, xa6Checks 41733, admits 17865, buildsOnSnapshot 9936, lingerReuses 3889, ringResumes 3586, ringFrames 3789, resumeBytes 522718, pictureBytes 12259850, frames 76050, frameBytes 7346118, encodes 76050, sends 76822, waits 6093 |
| xa2 | 1000 | 1 | {"refusedHeld":1} | checks 98863, framesApplied 62414, clientPictures 34493, disconnects 15482, clientRingResumes 1956, resumePictures 23282, kills 4425, admits 38121, refusedCap 3789, refusedHeld 1, buildsOnSnapshot 24287, lingerReuses 2608, ringResumes 2235, ringFrames 2093, resumeBytes 220066, pictureBytes 3427889, frames 81080, frameBytes 4032044, encodes 81080, sends 82379, waits 6472 |
| xa8ctl | 1000 | 0 | {} | checks 35602, framesApplied 31206, clientPictures 4396, xa6Checks 35602, admits 1131, lingerReuses 105, pictureBytes 498835, frames 11664, frameBytes 1445615, encodes 11664, sends 31359, waits 943 |
| xa9 | 1000 | 0 | {} | checks 117418, framesApplied 82444, clientPictures 32648, disconnects 13400, clientRingResumes 2326, resumePictures 19263, kills 3824, xa6Checks 40307, admits 31454, refusedCap 845, refusedHeld 285, buildsOnSnapshot 19724, lingerReuses 2660, ringResumes 2571, ringFrames 3076, resumeBytes 403455, pictureBytes 14976812, frames 93237, frameBytes 8750990, encodes 93237, sends 104985, waits 4718 |
| xa10 | 1000 | 0 | {} | checks 85924, framesApplied 62075, clientPictures 23287, disconnects 8632, clientRingResumes 562, resumePictures 14699, kills 5481, leaderKills 2536, xa6Checks 23918, admits 20200, ref_stale-client 2751, buildsOnSnapshot 14824, lingerReuses 686, ringResumes 603, ringFrames 681, resumeBytes 87207, pictureBytes 9002798, frames 65286, frameBytes 5539008, encodes 65286, sends 72626, waits 5351 |
| xa12 | 1000 | 0 | {} | checks 71175, framesApplied 52458, clientPictures 15134, disconnects 11782, clientRingResumes 3583, resumePictures 8415, kills 2893, xa6Checks 30105, admits 15095, tooBig 1641, warn80 23894, buildsOnSnapshot 7979, lingerReuses 3736, ringResumes 3898, ringFrames 3454, resumeBytes 520636, pictureBytes 8896033, frames 56041, frameBytes 5487934, encodes 56041, sends 57197, waits 3985 |
| xa13 | 1000 | 0 | {} | checks 92888, framesApplied 70935, clientPictures 19493, disconnects 10194, clientRingResumes 2460, resumePictures 11311, kills 3683, leaderKills 1178, xa6Checks 42979, admits 17669, syncs 1965, buildsOnSnapshot 11640, lingerReuses 3219, ringResumes 2650, ringFrames 3332, resumeBytes 444019, pictureBytes 11936874, frames 80174, frameBytes 8008577, encodes 80174, sends 79586, waits 8894 |
| xa2 | 1000 | 1 | {"refusedHeld":1} | checks 98863, framesApplied 62414, clientPictures 34493, disconnects 15482, clientRingResumes 1956, resumePictures 23282, kills 4425, admits 38121, refusedCap 3789, refusedHeld 1, buildsOnSnapshot 24287, lingerReuses 2608, ringResumes 2235, ringFrames 2093, resumeBytes 220066, pictureBytes 3427889, frames 81080, frameBytes 4032044, encodes 81080, sends 82379, waits 6472 |
| xa2l | 1000 | 21 | {"refusedHeld":27} | checks 102400, framesApplied 63409, clientPictures 37457, disconnects 13979, clientRingResumes 1534, resumePictures 23477, kills 5027, leaderKills 2100, admits 37484, refusedCap 845, refusedHeld 27, buildsOnSnapshot 27782, lingerReuses 2032, ringResumes 1708, ringFrames 1515, resumeBytes 163717, pictureBytes 3652991, frames 81891, frameBytes 4074452, encodes 81891, sends 81784, waits 6340 |
| xa2sb | 1000 | 377 | {"refusedHeld":665} | checks 100024, framesApplied 60414, clientPictures 37499, disconnects 13078, clientRingResumes 2111, resumePictures 22852, kills 5745, leaderKills 1902, admits 38242, refusedCap 1326, refusedHeld 665, buildsOnSnapshot 24952, lingerReuses 2592, ringResumes 2377, ringFrames 1446, resumeBytes 194082, pictureBytes 3585143, frames 74020, frameBytes 3682390, encodes 74020, sends 74058, waits 7521 |
| xa2sbx | 1000 | 6 | {"refusedHeld":8} | checks 112722, framesApplied 74130, clientPictures 37041, disconnects 14359, clientRingResumes 1551, resumePictures 21964, kills 5728, leaderKills 1950, admits 36766, refusedCap 312, refusedHeld 8, buildsOnSnapshot 24360, lingerReuses 2060, ringResumes 1668, ringFrames 1319, resumeBytes 151625, pictureBytes 3503920, frames 87577, frameBytes 4359012, encodes 87577, sends 86931, waits 9161 |
| xa2s2 | 1000 | 36 | {"refusedHeld":44} | checks 113833, framesApplied 78069, clientPictures 33571, disconnects 12010, clientRingResumes 2193, resumePictures 18972, kills 5946, leaderKills 1909, admits 34728, refusedCap 1391, refusedHeld 44, buildsOnSnapshot 18572, lingerReuses 2698, ringResumes 2391, ringFrames 1491, resumeBytes 197451, pictureBytes 3140974, frames 84894, frameBytes 4241636, encodes 84894, sends 85585, waits 9675 |
| xa2s2x | 1000 | 5 | {"refusedHeld":9} | checks 111764, framesApplied 74734, clientPictures 35395, disconnects 13674, clientRingResumes 1635, resumePictures 19699, kills 5957, leaderKills 1979, admits 36256, refusedCap 295, refusedHeld 9, buildsOnSnapshot 21692, lingerReuses 2121, ringResumes 1761, ringFrames 1058, resumeBytes 143250, pictureBytes 3273419, frames 85553, frameBytes 4262707, encodes 85553, sends 83385, waits 11816 |

### Deterministic runs

- `{"claim":"share","subscribers":1,"entries":3,"builds":3,"commits":200,"frames":277,"encodes":277,"sends":277,"decodes":277,"framesApplied":277,"unequal":0,"encodesPerFrame":1,"sendsPerFrame":1}`
- `{"claim":"share","subscribers":1000,"entries":3,"builds":3,"commits":200,"frames":288,"encodes":288,"sends":288000,"decodes":288000,"framesApplied":288000,"unequal":0,"encodesPerFrame":1,"sendsPerFrame":1000}`
- `{"claim":"sharing","subscribers":2000,"distinctKeys":25,"builds":25,"entries":25,"subsSent":1372,"joins":1347,"clientShares":628}`
- `{"claim":"placement","viewsMax":1000,"headroom":0,"subscribers":2000,"distinctKeys":50,"builds":50,"entriesPerCopy":[0,23,27],"distinctLive":50,"refusedFresh":0,"crossDup":0,"crossDupAfter":0,"afterKill":{"entriesPerCopy":[0,50,0],"refusedHeld":0,"refusedTotal":0,"leaderEntries":0}}`
- `{"claim":"placement","viewsMax":64,"headroom":32,"subscribers":2000,"distinctKeys":50,"builds":50,"entriesPerCopy":[0,23,27],"distinctLive":50,"refusedFresh":0,"crossDup":0,"crossDupAfter":0,"afterKill":{"entriesPerCopy":[0,50,0],"refusedHeld":0,"refusedTotal":0,"leaderEntries":0}}`
- `{"claim":"placement","viewsMax":40,"headroom":20,"subscribers":2000,"distinctKeys":50,"builds":40,"entriesPerCopy":[0,20,20],"distinctLive":40,"refusedFresh":323,"crossDup":0,"crossDupAfter":0,"afterKill":{"entriesPerCopy":[0,0,40],"refusedHeld":0,"refusedTotal":323,"leaderEntries":0}}`
- `{"claim":"pages","pageReads":1000,"answered":1000,"unequal":0,"tooManyViews":0,"refused":0,"indexesBuilt":1,"servedEntriesBuilt":0,"entriesPerCopy":[0,1,0]}`

## Planted bugs (each must fail at least 100 of 1,000 seeds)

| run | planted bug | seeds | seeds failed | why (first kinds) |
|---|---|---|---|---|
| a1 | keyedcopy | 1000 | **999** | {"unequal:frame:order":52496,"xa6":40902,"settled":3489} |
| a1 | floatsum | 1000 | **1000** | {"unequal:pic:value":2127,"unequal:frame:value":29372,"unequal:frame:bucket t1":9708,"unequal:pic:bucket t1":616,"unequal:frame:bucket t2":9596,"unequal:frame:b |
| a2 | ownseq | 1000 | **329** | {"backInTime":368,"missed":245,"doubled":243,"unequal:frame:order":1526,"xa6":1326,"unequal:resume:order":272,"settled":113,"xa4":42,"xa5":43,"unequal:frame:buc |
| a2 | noinstance | 1000 | **425** | {"missed":291,"unequal:frame:order":2093,"xa6":2408,"unequal:resume:order":568,"backInTime":78,"unequal:frame:bucket t0":59,"doubled":161,"settled":292,"xa4":42 |
| a3 | arrival | 1000 | **895** | {"unequal:pic:order":4274,"xa6":7674,"unequal:frame:order":7211,"settled":1276,"unequal:resume:order":229} |
| a3 | noseenwait | 1000 | **799** | {"backInTime":2106} |
| a3 | copyinst | 1000 | **319** | {"missed":121,"unequal:frame:order":550,"xa6":695,"unequal:resume:order":230,"settled":106,"backInTime":87,"doubled":71,"unequal:frame:bucket t3":42,"unequal:fr |
| a3 | onleader | 1000 | **1000** | {"leader":206915} |
| a3 | wholesale | 1000 | **969** | {"xa4unchanged":106752,"xa4":3} |
| a3 | noorderc | 1000 | **981** | {"xa5":15359} |
| a3 | keyedright | 1000 | **958** | {"xa6":19828} |
| a4 | allowonce | 1000 | **163** | {"leaked":550} |
| a4 | unsortedkey | 1000 | **355** | {"dupView":729} |
| a5 | doubledec | 1000 | **417** | {"admit":613,"capClient":11492,"join":56} |
| a5 | nolingercount | 1000 | **645** | {"admit":1235,"cap":7616,"capClient":6693,"join":33} |
| a6 | disposefirst | 1000 | **159** | {"unequal:resume:value":8,"settled":129,"unequal:pic:order":9,"xa6":20,"get":32,"unequal:pic:bucket t1":5,"unequal:pic:bucket t2":2,"unequal:pic:value":9,"unequ |
| a6 | handlerleak | 1000 | **817** | {"left":817} |
| a7 | keyedcopy | 1000 | **961** | {"unequal:frame:order":12950,"settled":1375,"unequal:resume:order":1066} |
| a7 | picorder | 1000 | **613** | {"xa5":1377,"unequal:pic:order":1377,"unequal:frame:order":1809,"settled":683,"unequal:resume:order":120} |
| a8 | nover | 1000 | **765** | {"oldVersionFrame":8215,"unequal:frame:order":3033,"xa6":3200,"unequal:frame:bucket t0":1552,"unequal:frame:bucket t3":1880,"unequal:frame:bucket t1":1447,"sett |
| xa2 | noheadroom | 1000 | **925** | {"admit":4018,"refusedHeld":49} |
| xa2 | freecopy | 1000 | **811** | {"crossDup":22839,"refusedHeld":1} |
| xa9 | countonly | 1000 | **363** | {"admit":1253,"cost":10039} |
| xa10 | tableversion | 1000 | **202** | {"versionBack":1063} |
| xa12 | nosticky | 1000 | **833** | {"rebuildTooBig":1812} |
| xa13 | earlysync | 1000 | **934** | {"sync":2890} |
| xa8 | (impure view) | 1000 | **822** | {"unequal:pic:order":4661,"xa6":4963,"unequal:resume:order":312,"settled":1119,"unequal:frame:order":84} |
| xa2sbx | fixedhead | 1000 | **841** | {"admit":3334} |
| xa2sbx | noheadroom | 1000 | **194** | {"admit":294,"refusedHeld":7} |

- `{"mutate":"unsortedkey","claim":"sharing","subscribers":2000,"distinctKeys":25,"builds":50,"entries":50,"subsSent":1372,"joins":1322,"clientShares":628}`
- `{"mutate":"freecopy","claim":"placement","viewsMax":1000,"headroom":0,"subscribers":2000,"distinctKeys":50,"builds":100,"entriesPerCopy":[0,50,50],"distinctLive":50,"refusedFresh":0,"crossDup":0,"crossDupAfter":50,"afterKill":{"entriesPerCopy":[0,0,50],"refusedHeld":0,"refusedTotal":0,"leaderEntries":0}}`
- `{"mutate":"freecopy","claim":"placement","viewsMax":64,"headroom":32,"subscribers":2000,"distinctKeys":50,"builds":64,"entriesPerCopy":[0,32,32],"distinctLive":42,"refusedFresh":587,"crossDup":0,"crossDupAfter":22,"afterKill":{"entriesPerCopy":[0,0,42],"refusedHeld":0,"refusedTotal":587,"leaderEntries":0}}`
- `{"mutate":"freecopy","claim":"placement","viewsMax":40,"headroom":20,"subscribers":2000,"distinctKeys":50,"builds":40,"entriesPerCopy":[0,20,20],"distinctLive":32,"refusedFresh":954,"crossDup":0,"crossDupAfter":8,"afterKill":{"entriesPerCopy":[0,0,32],"refusedHeld":0,"refusedTotal":954,"leaderEntries":0}}`
- `{"mutate":"noheadroom","claim":"placement","viewsMax":1000,"headroom":0,"subscribers":2000,"distinctKeys":50,"builds":50,"entriesPerCopy":[0,23,27],"distinctLive":50,"refusedFresh":0,"crossDup":0,"crossDupAfter":0,"afterKill":{"entriesPerCopy":[0,50,0],"refusedHeld":0,"refusedTotal":0,"leaderEntries":0}}`
- `{"mutate":"noheadroom","claim":"placement","viewsMax":64,"headroom":32,"subscribers":2000,"distinctKeys":50,"builds":50,"entriesPerCopy":[0,23,27],"distinctLive":50,"refusedFresh":0,"crossDup":0,"crossDupAfter":0,"afterKill":{"entriesPerCopy":[0,50,0],"refusedHeld":0,"refusedTotal":0,"leaderEntries":0}}`
- `{"mutate":"noheadroom","claim":"placement","viewsMax":40,"headroom":20,"subscribers":2000,"distinctKeys":50,"builds":50,"entriesPerCopy":[0,23,27],"distinctLive":50,"refusedFresh":0,"crossDup":0,"crossDupAfter":0,"afterKill":{"entriesPerCopy":[0,40,0],"refusedHeld":307,"refusedTotal":307,"leaderEntries":0}}`
- `{"mutate":"pageentry","claim":"pages","pageReads":1000,"answered":16,"unequal":0,"tooManyViews":984,"refused":984,"indexesBuilt":0,"servedEntriesBuilt":16,"entriesPerCopy":[0,16,0]}`

## Timed (range over the runs; each process alone under the timing lock)

### copycost @ 1000 (3 runs)

| number | range |
|---|---|
| writes | 2000 |
| usPerWrite.none:points | 0.75 to 0.853 |
| usPerWrite.none:pts | 0.628 to 0.829 |
| usPerWrite.best | 6.528 to 6.938 |
| usPerWrite.after | 4.998 to 5.928 |
| usPerWrite.byTeam | 4.495 to 5.139 |
| usPerWrite.total | 2.597 to 3.245 |
| viewUsPerChange.best | 5.712 to 6.188 |
| viewUsPerChange.after | 4.248 to 5.075 |
| viewUsPerChange.byTeam | 3.666 to 4.511 |
| viewUsPerChange.total | 1.768 to 2.597 |
| info.best.pictureBytes | 884 |
| info.best.framesPerWrite | 0.012 |
| info.best.bytesPerFrame | 134.6 |
| info.best.encodesPerFrame | 1 |
| info.after.pictureBytes | 1716 |
| info.after.framesPerWrite | 0.033 |
| info.after.bytesPerFrame | 135.7 |
| info.after.encodesPerFrame | 1 |
| info.byTeam.pictureBytes | 167 |
| info.byTeam.framesPerWrite | 0.999 |
| info.byTeam.bytesPerFrame | 64.7 |
| info.byTeam.encodesPerFrame | 1 |
| info.total.pictureBytes | 87 |
| info.total.framesPerWrite | 0.999 |
| info.total.bytesPerFrame | 60.2 |
| info.total.encodesPerFrame | 1 |

### copycost @ 10000 (3 runs)

| number | range |
|---|---|
| writes | 2000 |
| usPerWrite.none:points | 0.944 to 1.003 |
| usPerWrite.none:pts | 0.902 to 1.025 |
| usPerWrite.best | 18.397 to 20.081 |
| usPerWrite.after | 5.045 to 5.994 |
| usPerWrite.byTeam | 4.714 to 5.02 |
| usPerWrite.total | 3.292 to 3.548 |
| viewUsPerChange.best | 17.433 to 19.078 |
| viewUsPerChange.after | 4.101 to 4.991 |
| viewUsPerChange.byTeam | 3.701 to 4.004 |
| viewUsPerChange.total | 2.39 to 2.532 |
| info.best.pictureBytes | 910 |
| info.best.framesPerWrite | 0.002 |
| info.best.bytesPerFrame | 136.8 |
| info.best.encodesPerFrame | 1 |
| info.after.pictureBytes | 1759 |
| info.after.framesPerWrite | 0.005 |
| info.after.bytesPerFrame | 138 |
| info.after.encodesPerFrame | 1 |
| info.byTeam.pictureBytes | 170 |
| info.byTeam.framesPerWrite | 0.999 |
| info.byTeam.bytesPerFrame | 63.8 |
| info.byTeam.encodesPerFrame | 1 |
| info.total.pictureBytes | 88 |
| info.total.framesPerWrite | 0.999 |
| info.total.bytesPerFrame | 56.1 |
| info.total.encodesPerFrame | 1 |

### copycost @ 100000 (3 runs)

| number | range |
|---|---|
| writes | 1000 |
| usPerWrite.none:points | 1.204 to 1.452 |
| usPerWrite.none:pts | 1.308 to 1.476 |
| usPerWrite.best | 135.001 to 149.477 |
| usPerWrite.after | 13.698 to 14.502 |
| usPerWrite.byTeam | 6.082 to 6.216 |
| usPerWrite.total | 4.591 to 4.963 |
| viewUsPerChange.best | 133.683 to 148.273 |
| viewUsPerChange.after | 12.494 to 13.298 |
| viewUsPerChange.byTeam | 4.621 to 4.908 |
| viewUsPerChange.total | 3.224 to 3.487 |
| info.best.pictureBytes | 936 |
| info.best.framesPerWrite | 0 |
| info.best.bytesPerFrame | 0 |
| info.after.pictureBytes | 1805 |
| info.after.framesPerWrite | 0 |
| info.after.bytesPerFrame | 0 |
| info.byTeam.pictureBytes | 174 |
| info.byTeam.framesPerWrite | 0.999 |
| info.byTeam.bytesPerFrame | 66.4 |
| info.byTeam.encodesPerFrame | 1 |
| info.total.pictureBytes | 99 |
| info.total.framesPerWrite | 0.999 |
| info.total.bytesPerFrame | 65.2 |
| info.total.encodesPerFrame | 1 |

### resume @ 10000 (3 runs)

| number | range |
|---|---|
| best.framesMissed | 8 |
| best.bytes.ring | 1187 |
| best.bytes.picture | 921 |
| best.copyUsPerAnswer.ring | 1.404 to 1.728 |
| best.copyUsPerAnswer.picture | 5.849 to 6.23 |
| best.clientDecodeUs.ring | 9.015 to 9.537 |
| best.clientDecodeUs.picture | 5.902 to 6.802 |
| best.ringResumes | 5000 |
| best.pictures | 5001 |
| byTeam.framesMissed | 8 |
| byTeam.bytes.ring | 543 |
| byTeam.bytes.picture | 179 |
| byTeam.copyUsPerAnswer.ring | 1.375 to 1.541 |
| byTeam.copyUsPerAnswer.picture | 2.182 to 2.518 |
| byTeam.clientDecodeUs.ring | 4.531 to 4.778 |
| byTeam.clientDecodeUs.picture | 1.273 to 1.434 |
| byTeam.ringResumes | 5000 |
| byTeam.pictures | 5001 |

### rebuild @ 100000 (3 runs)

| number | range |
|---|---|
| buildMs.best | 90.2 to 97.1 |
| buildMs.byTeam | 32.1 to 37.6 |
| buildMs.total | 30 to 34.6 |
| oneBlock.best.maxStallMs | 94 to 101.1 |
| oneBlock.best.p99Ms | 0.2 to 0.3 |
| oneBlock.best.samples | 19 to 20 |
| oneBlock.best.wallMs | 95.1 to 102.2 |
| oneBlock.byTeam.maxStallMs | 32.6 to 45 |
| oneBlock.byTeam.p99Ms | 0.2 to 0.7 |
| oneBlock.byTeam.samples | 18 to 19 |
| oneBlock.byTeam.wallMs | 35.3 to 46 |
| oneBlock.total.maxStallMs | 22.6 to 25.6 |
| oneBlock.total.p99Ms | 2.7 to 3.4 |
| oneBlock.total.samples | 20 to 21 |
| oneBlock.total.wallMs | 27.2 to 30.8 |
| sliced.byTeam.slice | 20000 |
| sliced.byTeam.maxStallMs | 15 to 16.3 |
| sliced.byTeam.p99Ms | 8.9 to 9.9 |
| sliced.byTeam.samples | 22 to 23 |
| sliced.byTeam.wallMs | 54 to 58.2 |
| sliced.total.slice | 20000 |
| sliced.total.maxStallMs | 14.8 to 16.1 |
| sliced.total.p99Ms | 7.4 to 8.6 |
| sliced.total.samples | 22 to 23 |
| sliced.total.wallMs | 44.5 to 51 |
| slicedCheck.commitsBetweenSlices | 400 |
| slicedCheck.unequalBuckets | 0 |

### rebuild @ 1000000 (3 runs)

| number | range |
|---|---|
| buildMs.best | 1440.1 to 1520.5 |
| buildMs.byTeam | 643 to 719.9 |
| buildMs.total | 498 to 523.2 |
| oneBlock.best.maxStallMs | 1495.3 to 1892.6 |
| oneBlock.best.p99Ms | 0.2 to 0.3 |
| oneBlock.best.samples | 19 to 20 |
| oneBlock.best.wallMs | 1496.5 to 1893.8 |
| oneBlock.byTeam.maxStallMs | 648.5 to 740.6 |
| oneBlock.byTeam.p99Ms | 0.2 to 0.4 |
| oneBlock.byTeam.samples | 19 |
| oneBlock.byTeam.wallMs | 650.6 to 741.7 |
| oneBlock.total.maxStallMs | 492.6 to 497.7 |
| oneBlock.total.p99Ms | 0.3 to 0.4 |
| oneBlock.total.samples | 18 to 20 |
| oneBlock.total.wallMs | 493.7 to 498.7 |
| sliced.byTeam.slice | 20000 |
| sliced.byTeam.maxStallMs | 211.1 to 230.7 |
| sliced.byTeam.p99Ms | 25.8 to 27.1 |
| sliced.byTeam.samples | 68 to 69 |
| sliced.byTeam.wallMs | 747.2 to 772.6 |
| sliced.total.slice | 20000 |
| sliced.total.maxStallMs | 222.2 to 239.7 |
| sliced.total.p99Ms | 25.5 to 33 |
| sliced.total.samples | 67 to 68 |
| sliced.total.wallMs | 692.4 to 753.8 |
| slicedCheck.commitsBetweenSlices | 400 |
| slicedCheck.unequalBuckets | 0 |

### joincost @ 10000 (3 runs)

| number | range |
|---|---|
| joins | 10000 |
| usPerJoinWithPicture | 6.413 to 7.206 |
| usPerPicture | 4.405 to 5.179 |
| usPerJoinAlone | 2.008 to 2.074 |
| bytesPerSubscriber | 496.3 |

### viewmem @ 10000 (3 runs)

| number | range |
|---|---|
| bytesPerBestView | 1083503 |
| sizeCheckNsPerEntry | 10.4 to 12 |
| pages.indexes | 1 |
| pages.entries | 1 |
| pages.heapPerRead | 32 to 33 |
| pages.usPerRead | 10.2 to 15.8 |
| entryPerCursor.entries | 16 |
| entryPerCursor.heapPerEntry | 719811 |

### viewmem @ 100000 (3 runs)

| number | range |
|---|---|
| bytesPerBestView | 9061610 |
| sizeCheckNsPerEntry | 10.4 to 11.9 |
| pages.indexes | 1 |
| pages.entries | 1 |
| pages.heapPerRead | 32 |
| pages.usPerRead | 14 to 16.4 |
| entryPerCursor.entries | 16 |
| entryPerCursor.heapPerEntry | 8306778 |

### classb @ 1000 (3 runs)

| number | range |
|---|---|
| S1.copyUsPerWrite.none | 3.045 to 4.145 |
| S1.copyUsPerWrite.push | 4.847 to 5.608 |
| S1.copyUsPerWrite.local | 2.707 to 3.658 |
| S1.clientUsPerWrite.none | 3.022 to 3.505 |
| S1.clientUsPerWrite.push | 0.044 to 0.048 |
| S1.clientUsPerWrite.local | 5.661 to 6.696 |
| S1.copyUsPerShape.push | 1.463 to 2.32 |
| S1.copyUsPerShape.local | -0.487 to -0.313 |
| S1.clientUsPerShape.push | 0.044 to 0.048 |
| S1.clientUsPerShape.local | 2.639 to 3.191 |
| S1.bytesPerWrite.push | 3.1 |
| S1.bytesPerWrite.local | 108 |
| S10.copyUsPerWrite.none | 2.484 to 2.727 |
| S10.copyUsPerWrite.push | 14.234 to 15.636 |
| S10.copyUsPerWrite.local | 2.389 to 2.578 |
| S10.clientUsPerWrite.none | 2.194 to 2.354 |
| S10.clientUsPerWrite.push | 0.231 to 0.248 |
| S10.clientUsPerWrite.local | 15.393 to 18.077 |
| S10.copyUsPerShape.push | 1.175 to 1.293 |
| S10.copyUsPerShape.local | -0.018 to -0.01 |
| S10.clientUsPerShape.push | 0.023 to 0.025 |
| S10.clientUsPerShape.local | 1.32 to 1.575 |
| S10.bytesPerWrite.push | 28 |
| S10.bytesPerWrite.local | 108 |

### classb @ 10000 (3 runs)

| number | range |
|---|---|
| S1.copyUsPerWrite.none | 2.884 to 3.756 |
| S1.copyUsPerWrite.push | 5.601 to 6.427 |
| S1.copyUsPerWrite.local | 2.945 to 3.203 |
| S1.clientUsPerWrite.none | 2.22 to 2.348 |
| S1.clientUsPerWrite.push | 0.019 to 0.028 |
| S1.clientUsPerWrite.local | 6.673 to 7.307 |
| S1.copyUsPerShape.push | 2.671 to 3.197 |
| S1.copyUsPerShape.local | -0.553 to 0.061 |
| S1.clientUsPerShape.push | 0.019 to 0.028 |
| S1.clientUsPerShape.local | 4.378 to 4.959 |
| S1.bytesPerWrite.push | 0.1 |
| S1.bytesPerWrite.local | 112.7 |
| S10.copyUsPerWrite.none | 2.688 to 2.797 |
| S10.copyUsPerWrite.push | 24.24 to 32.976 |
| S10.copyUsPerWrite.local | 2.767 to 2.823 |
| S10.clientUsPerWrite.none | 1.936 to 2.173 |
| S10.clientUsPerWrite.push | 0.035 to 0.039 |
| S10.clientUsPerWrite.local | 26.684 to 33.398 |
| S10.copyUsPerShape.push | 2.153 to 3.018 |
| S10.copyUsPerShape.local | 0.003 to 0.01 |
| S10.clientUsPerShape.push | 0.004 |
| S10.clientUsPerShape.local | 2.475 to 3.123 |
| S10.bytesPerWrite.push | 1.3 |
| S10.bytesPerWrite.local | 112.7 |

### pagecost @ 1000 (3 runs)

| number | range |
|---|---|
| writes | 2000 |
| pageIndexesBuilt | 1 |
| usPerWrite.none | 0.816 to 0.902 |
| usPerWrite.best | 6.896 to 7.537 |
| usPerWrite.pages | 9.117 to 9.936 |
| usPerWrite.both | 12.443 to 13.79 |
| viewUsPerChange.best | 6.08 to 6.692 |
| viewUsPerChange.pages | 8.301 to 9.091 |
| viewUsPerChange.both | 11.627 to 12.945 |

### pagecost @ 5000 (3 runs)

| number | range |
|---|---|
| writes | 2000 |
| pageIndexesBuilt | 1 |
| usPerWrite.none | 0.944 to 1.132 |
| usPerWrite.best | 13.21 to 16.855 |
| usPerWrite.pages | 19.682 to 20.606 |
| usPerWrite.both | 29.113 to 37.794 |
| viewUsPerChange.best | 12.214 to 15.723 |
| viewUsPerChange.pages | 18.738 to 19.474 |
| viewUsPerChange.both | 28.169 to 36.662 |

### pagecost @ 10000 (3 runs)

| number | range |
|---|---|
| writes | 2000 |
| pageIndexesBuilt | 1 |
| usPerWrite.none | 1.008 to 1.147 |
| usPerWrite.best | 20.837 to 21.778 |
| usPerWrite.pages | 30.451 to 34.24 |
| usPerWrite.both | 48.643 to 54.69 |
| viewUsPerChange.best | 19.829 to 20.643 |
| viewUsPerChange.pages | 29.443 to 33.142 |
| viewUsPerChange.both | 47.496 to 53.592 |

### pagecost @ 100000 (3 runs)

| number | range |
|---|---|
| writes | 1000 |
| pageIndexesBuilt | 1 |
| usPerWrite.none | 1.345 to 1.43 |
| usPerWrite.best | 148.026 to 156.108 |
| usPerWrite.pages | 510.063 to 526.635 |
| usPerWrite.both | 673.712 to 710.497 |
| viewUsPerChange.best | 146.596 to 154.694 |
| viewUsPerChange.pages | 508.649 to 525.29 |
| viewUsPerChange.both | 672.298 to 709.067 |

## Types (XA-11)

- `{"exp":"E-57","claim":"XA-11","tsc":"Version 6.0.2","exit":0,"errors":""}`
- `{"exp":"E-57","claim":"XA-11","config":"expect-error lines stripped","errors":"_stripped.ts(47,46): error TS2339 _stripped.ts(49,41): error TS2339 _stripped.ts(51,61): error TS2339 "}`
