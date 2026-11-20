# E-58: tables from the raw lines

Made by `node summarize.mjs` from `results/*.jsonl`. Each seeded line ran under the heavy lock; a seed gives the same line every time. Where a run was made again, the tables use its newest line (see "Runs made again").

## Seeded runs: seeds that broke a checked rule

In the shape and edge runs a broken rule is counted by the write that caused it, not failed.

| run | seeds | seeds failed | seconds | lines |
|---|---|---|---|---|
| oracle depth 1 main | 1000 | 0 | 6.463 | 2 |
| oracle depth 1 shape | 1000 | 0 | 10.7 | 1 |
| oracle depth 2 main | 1000 | 0 | 10.288 | 2 |
| oracle depth 2 shape | 1000 | 0 | 16.553 | 1 |
| split | 1000 | 0 | 0.573 | 1 |
| filter | 1000 | 0 | 0.975 | 1 |
| versions sibling 0.2 | 1000 | 0 | 0.162 | 1 |
| versions sibling 0.5 | 1000 | 0 | 0.147 | 1 |
| versions sibling 0.8 | 1000 | 0 | 0.134 | 1 |
| oracle depth 1 edge | 1000 | 0 | 11.403 | 1 |
| oracle depth 1 merge | 1000 | 0 | 6.479 | 1 |
| oracle depth 2 edge | 1000 | 0 | 14.794 | 1 |
| oracle depth 2 merge | 1000 | 0 | 8.417 | 1 |

## Runs made again

Each row: the first line of a run against its newest line. A counter the newer code added is "new"; every counter the first line had must be equal.

| run | counters in the first line | equal in the newest | new counters | seeds failed (first, newest) |
|---|---|---|---|---|
| oracle depth 1 main | 354 | 354 | 40 | 0, 0 |
| oracle depth 2 main | 359 | 359 | 47 | 0, 0 |

## Part 1, depth 1: 120000 commits, 156762 records, 1000 seeds

Counts are lens-commits: one lens after one commit. "Changed" means the model's value at the lens changed.

| lens | changed | data fired | data fired, value equal: new equal object | data fired, value equal: phantom undefined | data missed | E-55 called | E-55 called, value equal: beside | E-55 called, value equal: at, above or below | log "under": changes with no record under | log "near": hits with value equal |
|---|---|---|---|---|---|---|---|---|---|---|
| root | 104578 | 112209 | 7631 | 0 | 0 | 112209 (1.07 per change) | 0 | 7631 | 0 (0.0 %) | 15422 of 120000 |
| row | 58768 | 62763 | 3995 | 0 | 0 | 62763 (1.07 per change) | 0 | 3995 | 0 (0.0 %) | 8071 of 66839 |
| absent-row | 25252 | 26919 | 1667 | 0 | 0 | 26919 (1.07 per change) | 0 | 1667 | 0 (0.0 %) | 3431 of 28683 |
| field | 45083 | 50998 | 2545 | 3370 | 0 | 94338 (2.09 per change) | 35405 | 13850 | 28851 (64.0 %) | 15892 of 60975 |
| nested | 27950 | 30748 | 0 | 2798 | 0 | 62924 (2.25 per change) | 20860 | 14114 | 23512 (84.1 %) | 15298 of 43248 |
| element | 10304 | 12786 | 371 | 2111 | 0 | 31446 (3.05 per change) | 12735 | 8407 | 7715 (74.9 %) | 9053 of 19357 |
| element-field | 6354 | 8863 | 0 | 2509 | 0 | 31478 (4.95 per change) | 12559 | 12565 | 5099 (80.2 %) | 13233 of 19587 |
| not-there | 17609 | 21707 | 0 | 4098 | 0 | 58365 (3.31 per change) | 22688 | 18068 | 14191 (80.6 %) | 19495 of 37104 |

Below a row (field, nested, element, element-field, not-there): 107300 changes; data fired 125102 times; E-55 called 278551 times; the "under" reading missed 79368 changes (74.0 %); the "near" reading missed 0.

Writes the leader refused: absent-row 390; absent-row:batch 1937; absent-row:element-set 855; absent-row:field-on-missing-row 6043; absent-row:field-set 1121; absent-row:nested-set 864; invalid 2339; sparse-hole:element-remove 504.

Field writes v5 would refuse `absent-path` (a missing parent field) that data fills in: 13420. Field writes under a primitive parent field (v5 silent, data makes it {}): 4301.

Part 2 on these commits: road 1 (the log records as written) sent 75620 records to the client and held back 81142 of partitions it does not hold; road 2 (E-55's c.recs(), merged per row) sent 58365 and held back 62795. Lane rejects: 0.

### -N on depth 1: (seed, lens) pairs where the reading lands on another commit than the reference

| N | lens | pairs | data vs value | E-55 vs value | near vs value | under vs value | E-55 vs data | near vs data | under vs data |
|---|---|---|---|---|---|---|---|---|---|
| 1 | row and above | 4000 | 4.8 % | 4.8 % | 12.2 % | 12.2 % | 0.0 % | 7.5 % | 7.5 % |
| 1 | below a row | 9000 | 22.5 % | 55.9 % | 46.0 % | 86.6 % | 51.8 % | 39.4 % | 88.1 % |
| 5 | row and above | 4000 | 26.3 % | 26.3 % | 47.1 % | 47.1 % | 0.0 % | 27.6 % | 27.6 % |
| 5 | below a row | 9000 | 53.3 % | 97.4 % | 86.3 % | 88.1 % | 95.9 % | 78.4 % | 95.5 % |

## Part 1, depth 2: 120000 commits, 179149 records, 1000 seeds

Counts are lens-commits: one lens after one commit. "Changed" means the model's value at the lens changed.

| lens | changed | data fired | data fired, value equal: new equal object | data fired, value equal: phantom undefined | data missed | E-55 called | E-55 called, value equal: beside | E-55 called, value equal: at, above or below | log "under": changes with no record under | log "near": hits with value equal |
|---|---|---|---|---|---|---|---|---|---|---|
| root | 105275 | 112156 | 6881 | 0 | 0 | 112156 (1.07 per change) | 0 | 6881 | 0 (0.0 %) | 14725 of 120000 |
| partition | 73052 | 77441 | 4389 | 0 | 0 | 77441 (1.06 per change) | 0 | 4389 | 0 (0.0 %) | 9564 of 82616 |
| row | 27901 | 29290 | 1389 | 0 | 0 | 29290 (1.05 per change) | 0 | 1389 | 0 (0.0 %) | 3524 of 31425 |
| absent-row | 11582 | 12069 | 487 | 0 | 0 | 12069 (1.04 per change) | 0 | 487 | 0 (0.0 %) | 1565 of 13147 |
| field | 15165 | 16826 | 619 | 1042 | 0 | 29418 (1.94 per change) | 10646 | 3607 | 11289 (74.4 %) | 4484 of 19649 |
| nested | 13349 | 15145 | 0 | 1796 | 0 | 29337 (2.20 per change) | 9384 | 6604 | 11622 (87.1 %) | 7412 of 20761 |
| element | 5043 | 6456 | 68 | 1345 | 0 | 14709 (2.92 per change) | 5521 | 4145 | 4008 (79.5 %) | 4576 of 9619 |
| not-there | 9281 | 12001 | 428 | 2292 | 0 | 26076 (2.81 per change) | 9196 | 7599 | 6578 (70.9 %) | 8516 of 17797 |

Below a row (field, nested, element, element-field, not-there): 42838 changes; data fired 50428 times; E-55 called 99540 times; the "under" reading missed 33497 changes (78.2 %); the "near" reading missed 0.

E-55 handed a row or field link a commit holding other rows of its room (not cut to the link's rows): 52493 lens-commits.

Writes the leader refused: absent-row 147; absent-row:batch 748; absent-row:element-set 330; absent-row:field-on-missing-row 6453; absent-row:field-set 427; absent-row:nested-set 337; invalid 2317; sparse-hole:element-remove 450.

Field writes v5 would refuse `absent-path` (a missing parent field) that data fills in: 14386. Field writes under a primitive parent field (v5 silent, data makes it {}): 4349.

Part 2 on these commits: road 1 (the log records as written) sent 117241 records to the client and held back 61908 of partitions it does not hold; road 2 (E-55's c.recs(), merged per row) sent 101006 and held back 53352. Lane rejects: 0.

### -N on depth 2: (seed, lens) pairs where the reading lands on another commit than the reference

| N | lens | pairs | data vs value | E-55 vs value | near vs value | under vs value | E-55 vs data | near vs data | under vs data |
|---|---|---|---|---|---|---|---|---|---|
| 1 | row and above | 6000 | 3.7 % | 3.7 % | 13.2 % | 13.2 % | 0.0 % | 9.8 % | 9.8 % |
| 1 | below a row | 7000 | 23.6 % | 47.9 % | 43.5 % | 86.2 % | 43.8 % | 36.6 % | 89.8 % |
| 5 | row and above | 6000 | 20.1 % | 20.1 % | 44.0 % | 44.0 % | 0.0 % | 29.8 % | 29.8 % |
| 5 | below a row | 7000 | 39.8 % | 88.6 % | 73.7 % | 62.2 % | 85.9 % | 64.3 % | 72.6 % |

## Shapes v5 does not define, depth 1 (1000 seeds)

Writes: batch(shape:field-on-number-row) 175; batch(shape:field-on-string-row) 43; batch(shape:named-field-on-array) 514; batch(shape:past-array-end) 432; batch(shape:write-under-string-field) 143; shape:field-on-number-row 677; shape:field-on-string-row 194; shape:named-field-on-array 1135; shape:past-array-end 1014; shape:write-under-string-field 350.

Where the engine left the model (each a count of commits, by the write that caused it):

- the row differs from a clean field write: batch(shape:field-on-string-row) 16
- the row differs from a clean field write: shape:field-on-string-row 194
- road2: a client lens first differs from the server after batch: 35
- road2: a client lens first differs from the server after batch(shape:named-field-on-array): 104
- road2: a client lens first differs from the server after batch(shape:past-array-end): 90
- road2: a client lens first differs from the server after op-merge: 75
- road2: a client lens first differs from the server after row-equal-copy: 88
- wire: a client lens first differs from the server after op-merge: 85
- wire: a client lens first differs from the server after row-equal-copy: 106
- client:lane-reject:sparse-hole: 3
- data:compose-through-string:element: 27
- data:missed-through-string:element: 27
- log-near:fold-through-string:element: 37
- log-near:missed-through-string:element: 29

## Shapes v5 does not define, depth 2 (1000 seeds)

Writes: batch(shape:field-on-number-row) 305; batch(shape:field-on-string-row) 44; batch(shape:named-field-on-array) 442; batch(shape:past-array-end) 439; batch(shape:write-under-string-field) 99; shape:field-on-number-row 878; shape:field-on-string-row 110; shape:named-field-on-array 1034; shape:past-array-end 1084; shape:write-under-string-field 204.

Where the engine left the model (each a count of commits, by the write that caused it):

- the row differs from a clean field write: batch(shape:field-on-string-row) 37
- the row differs from a clean field write: shape:field-on-string-row 110
- road2: a client lens first differs from the server after batch: 45
- road2: a client lens first differs from the server after batch(shape:field-on-number-row): 1
- road2: a client lens first differs from the server after batch(shape:named-field-on-array): 117
- road2: a client lens first differs from the server after batch(shape:past-array-end): 119
- road2: a client lens first differs from the server after op-merge: 63
- road2: a client lens first differs from the server after row-equal-copy: 79
- wire: a client lens first differs from the server after op-merge: 69
- wire: a client lens first differs from the server after row-equal-copy: 88
- client:lane-reject:sparse-hole: 3
- data:compose-through-string:element: 7
- data:missed-through-string:element: 7
- log-near:fold-through-string:element: 13
- log-near:missed-through-string:element: 8

## Part 2, depth 1: data's reader ran with an unchanged value (lens-commits; added after the review)

The server applies the leader's values; the client applies records that crossed JSON, which makes new objects, so a reader on an object value runs again for any record above it that leaves it equal. "merge": the same seeds, with a row's `op.merge` appended as one field record per merged key.

| mode | where | readers ran | of which unchanged: a new equal object | of which unchanged: a phantom undefined | the new equal objects by write (top 6) |
|---|---|---|---|---|---|
| main | server | 326993 | 16209 | 14886 | field-equal-copy 8270; row-equal-copy 6658; op-merge 557; field-set 352; element-set 170; batch 126 |
| main | client, road 1 | 159798 | 7106 | 10986 | field-equal-copy 3086; row-equal-copy 2717; op-merge 947; field-set 128; batch 88; element-set 76 |
| merge | server | 326440 | 15656 | 14886 | field-equal-copy 8270; row-equal-copy 6658; field-set 352; element-set 170; batch 126; row-replace 56 |
| merge | client, road 1 | 158853 | 6161 | 10986 | field-equal-copy 3086; row-equal-copy 2717; field-set 128; batch 88; element-set 76; row-replace 44 |

merge, depth 1: 0 of 1000 seeds failed; 5331 merges; "under" missed 78365 changes below a row.

## Part 2, depth 2: data's reader ran with an unchanged value (lens-commits; added after the review)

The server applies the leader's values; the client applies records that crossed JSON, which makes new objects, so a reader on an object value runs again for any record above it that leaves it equal. "merge": the same seeds, with a row's `op.merge` appended as one field record per merged key.

| mode | where | readers ran | of which unchanged: a new equal object | of which unchanged: a phantom undefined | the new equal objects by write (top 6) |
|---|---|---|---|---|---|
| main | server | 281384 | 14261 | 6475 | field-equal-copy 8572; row-equal-copy 5009; field-set 246; op-merge 204; element-set 137; batch 50 |
| main | client, road 1 | 147157 | 6761 | 5566 | field-equal-copy 4024; row-equal-copy 2288; op-merge 221; field-set 98; element-set 60; batch 33 |
| merge | server | 281185 | 14062 | 6475 | field-equal-copy 8572; row-equal-copy 5009; field-set 246; element-set 137; batch 50; row-replace 27 |
| merge | client, road 1 | 146940 | 6544 | 5566 | field-equal-copy 4024; row-equal-copy 2288; field-set 98; element-set 60; batch 33; row-replace 21 |

merge, depth 2: 0 of 1000 seeds failed; 5393 merges; "under" missed 33130 changes below a row.

## Edges of data's rule, depth 1 (1000 seeds; added after the review)

Writes: batch(edge:append-at-end) 158; batch(edge:length-write) 307; batch(edge:proto-key) 467; batch(edge:proto-key-nested) 472; edge:append-at-end 322; edge:length-write 665; edge:proto-key 1058; edge:proto-key-nested 1109.

Lenses: `length` reads an array's length (`r0.list.length`); `proto-read` reads `r0.p`, which only a `__proto__` write can give; `not-there` includes `r0.q.z`. Counts are lens-commits.

| lens | data's reader missed a change | of which right after an edge write | the "near" log reader missed a change | a client joining now first differs from the server |
|---|---|---|---|---|
| length | 80 | 80 | 90 | 0 |
| proto-read | 383 | 248 | 399 | 266 |
| not-there | 219 | 219 | 238 | 258 |
| element | 187 | 187 | 201 | 1 |
| element-field | 72 | 72 | 80 | 0 |

On `proto-read`, 135 misses came after an ordinary write to the row (field-set 36, nested-set 25, element-set 21, field-to-primitive 14): data copies the row's own keys, so the value a `__proto__` write gave went away with no record.
- road2: a client lens first differs from the server after batch: 6
- road2: a client lens first differs from the server after batch(edge:append-at-end): 2
- road2: a client lens first differs from the server after batch(edge:length-write): 10
- road2: a client lens first differs from the server after batch(edge:proto-key): 26
- road2: a client lens first differs from the server after batch(edge:proto-key-nested): 42
- road2: a client lens first differs from the server after op-merge: 11
- wire: a client lens first differs from the server after batch: 1
- wire: a client lens first differs from the server after op-merge: 16
- wire: a client lens first differs from the server after row-equal-copy: 1

## Edges of data's rule, depth 2 (1000 seeds; added after the review)

Writes: batch(edge:append-at-end) 143; batch(edge:length-write) 309; batch(edge:proto-key) 471; batch(edge:proto-key-nested) 508; edge:append-at-end 308; edge:length-write 592; edge:proto-key 1092; edge:proto-key-nested 1044.

Lenses: `length` reads an array's length (`r0.list.length`); `proto-read` reads `r0.p`, which only a `__proto__` write can give; `not-there` includes `r0.q.z`. Counts are lens-commits.

| lens | data's reader missed a change | of which right after an edge write | the "near" log reader missed a change | a client joining now first differs from the server |
|---|---|---|---|---|
| length | 35 | 35 | 42 | 0 |
| proto-read | 211 | 130 | 231 | 147 |
| not-there | 97 | 97 | 117 | 116 |
| element | 67 | 67 | 69 | 1 |

On `proto-read`, 81 misses came after an ordinary write to the row (field-set 21, nested-set 14, batch 12, element-set 12): data copies the row's own keys, so the value a `__proto__` write gave went away with no record.
- road2: a client lens first differs from the server after batch: 1
- road2: a client lens first differs from the server after batch(edge:append-at-end): 2
- road2: a client lens first differs from the server after batch(edge:length-write): 12
- road2: a client lens first differs from the server after batch(edge:proto-key): 20
- road2: a client lens first differs from the server after batch(edge:proto-key-nested): 24
- road2: a client lens first differs from the server after op-merge: 5
- wire: a client lens first differs from the server after nested-set: 1
- wire: a client lens first differs from the server after op-merge: 5
- wire: a client lens first differs from the server after row-equal-copy: 4

## Part 3: a write across partitions (1000 seeds)

- A. 20000 root replaces over 2 to 8 partitions, 101760 partition commits. A callback on two rows saw a mixed state in 20000 (100.0 %); a loop that wakes after 1 to 4 commits in 12629 (63.1 %); a whole-resource callback in 20000, 106128 mixed states in all (5.31 a replace).
- B. 20000 moves of a row between two rooms (10044 remove first, 9956 add first). A callback on both rooms saw the row in both or neither in 20000 (100.0 %); the loop in 7818 (39.1 %).
- C. 20000 room replaces as one batch (20000 commits): mixed states 0 (checked; 0 seeds failed).

## Part 4: a filter on the record alone (1000 seeds, 200000 records)

Records: field-name 19411; field-price 38872; field-remove-stock 9899; field-stock 49123; row-add 32833; row-remove 29089; row-replace 20773.

| filter | field-only records | docs consumer misjudged | of the field-only records | entries it never sees | exits it never sees | seeds whose final set is wrong | key consumer, row consumer misjudged |
|---|---|---|---|---|---|---|---|
| F1 | 117305 | 76291 | 65.0 % | 11549 of 41096 | 15267 of 38493 | 582 | 0, 0 |
| F2 | 117305 | 37914 | 32.3 % | 12385 of 29761 | 14220 of 28440 | 584 | 0, 0 |

The docs consumer's set was wrong after 108117 (F1) and 107881 (F2) of 200000 records. The key consumer kept 3423 (F1) and 7167 (F2) field values at the end of all seeds.

## Part 5: a version per row

| sibling share | guarded writes | row guard refused | of which only a sibling changed (of the refusals; of the guarded writes) | field guard refused | equals refused | equals passed after a change and back |
|---|---|---|---|---|---|---|
| 0.2 | 118637 | 84986 (71.6 %) | 9162 (10.8 %; 7.7 %) | 75824 | 60278 | 15546 |
| 0.5 | 118554 | 85089 (71.8 %) | 27566 (32.4 %; 23.3 %) | 57523 | 45338 | 12185 |
| 0.8 | 119097 | 85424 (71.7 %) | 54021 (63.2 %; 45.4 %) | 31403 | 24313 | 7090 |

## Planted bugs (each must fail at least 100 of 1,000 seeds)

| run | planted bug | seeds | seeds failed | first kinds |
|---|---|---|---|---|
| oracle depth 1 | rowmerge | 1000 | **1000** | state:root, compose:root, state:nested, compose:nested |
| oracle depth 1 | inplace | 1000 | **1000** | missed:root, compose:row, missed:row, compose:nested |
| oracle depth 1 | under | 1000 | **1000** | compose:nested, missed:nested, compose:element-field, missed:element-field |
| oracle depth 1 | prev | 1000 | **1000** | prev:root, prev:element-field, prev:nested, prev:element |
| oracle depth 1 | nearbeside | 1000 | **1000** | log-near:fold:nested, log-near:fold:element-field, log-near:fold:field, log-near:fold:element |
| oracle depth 1 | wirefield | 1000 | **1000** | wire:state:row, wire:missed:row, wire:state:not-there, wire:missed:not-there |
| oracle depth 2 | rowmerge | 1000 | **1000** | state:root, compose:root, state:partition, compose:partition |
| oracle depth 2 | inplace | 1000 | **1000** | compose:nested, road2:state:partition, missed:root, missed:nested |
| oracle depth 2 | under | 1000 | **1000** | compose:nested, missed:nested, compose:not-there, missed:not-there |
| oracle depth 2 | prev | 1000 | **1000** | prev:root, prev:nested, prev:partition, prev:element |
| oracle depth 2 | nearbeside | 1000 | **1000** | log-near:fold:nested, log-near:fold:field, log-near:fold:element, log-near:fold:not-there |
| oracle depth 2 | wirefield | 1000 | **1000** | wire:state:partition, wire:missed:partition, wire:state:absent-row, wire:missed:absent-row |
| split | splitrows | 1000 | **1000** | C:mixed |
| filter | prevrow | 1000 | **1000** | F1:row, F1:row:set, F2:row, F2:row:set |
| versions | noancestor | 1000 | **1000** | field:lost-update |
| oracle depth 1 merge | prev | 1000 | **1000** | prev:root, prev:element-field, prev:nested, prev:element |
| oracle depth 1 merge | wirefield | 1000 | **1000** | wire:state:row, wire:missed:row, wire:state:not-there, wire:missed:not-there |

## Timed (range over the runs; each process alone under the timing lock; medians of 15 interleaved rounds)

### T1: a room replaced as one batch, or row by row

| rows | runs | one batch, µs | row by row, µs | ratio | sink calls (batch, row by row) |
|---|---|---|---|---|---|
| 10 | 3 | 2.072 to 2.988 | 9.008 to 10.766 | 3.6 to 4.35 | 1, 10 |
| 100 | 3 | 16.273 to 22.956 | 91.746 to 126.133 | 5.49 to 5.89 | 1, 100 |
| 1000 | 3 | 534.914 to 557.596 | 1241.246 to 1504.017 | 2.32 to 2.7 | 1, 1000 |

### T2: what data's read rule costs a field link

| links | runs | no links, ns a commit | E-55 rule | data's rule | E-55, ns a link | data's rule, ns a link | data's minus E-55, ns a link | callbacks a commit (E-55, data's rule) |
|---|---|---|---|---|---|---|---|---|
| 10 | 3 | 745 to 878 | 1018 to 1215 | 1098 to 1189 | 20.9 to 38.3 | 28.9 to 38.7 | -2.6 to 8 | 10, 0.591 |
| 100 | 3 | 770 to 996 | 2332 to 2742 | 3324 to 3598 | 15.6 to 17.5 | 24.1 to 27.5 | 6.7 to 11.2 | 99.998, 5 |
