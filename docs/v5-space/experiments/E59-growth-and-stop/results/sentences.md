absent G2: HF on o1d (4 steps)
absent G3: B2B on o1 (6 steps)
absent G1: GF on g0 (0 steps)
absent G5: DL on o1d (1 steps)
absent G4: HF on o1f (6 steps)
absent H-prom: GF on g0 (0 steps)
absent H-add: HF on r1s (1 steps)
absent H-sur: HF on r1s (1 steps)
absent H-pick: HF on r1s (1 steps)
absent S1: SF on o1 (1 steps)
absent S2: P7 on o1 (12 steps)
absent S3: nothing breaks
absent S4: HF on o1 (1 steps)
absent S5: HF on o1 (1 steps)
absent S6: SF on s2 (2 steps)
absent S7: DX on solo (2 steps)
absent S8: LW on o1 (8 steps)
absent H-rem: nothing breaks
absent S10: nothing breaks
absent S11: SF on solo (1 steps)
absent 2.3 rule 1: HF on o1d (4 steps)
absent 8.9 B1: SF on o1 (1 steps)
absent 8.9 B4: DX on solo (2 steps)
absent only voter: HF on o1 (1 steps)
shrink G1: GF on g0 (0 steps)
shrink G2: HF on o1d (4 steps)
shrink G3: B2B on o1 (6 steps)
shrink G4: HF on o1f (6 steps)
shrink G5: DL on o1d (1 steps)
absent S9: nothing breaks
shrink H-prom: GF on g0 (0 steps)
shrink H-add: HF on r1s (1 steps)
shrink H-sur: HF on r1s (1 steps)
shrink H-pick: HF on r1s (1 steps)
shrink S1: SF on o1 (1 steps)
shrink S2: P7 on o1 (12 steps)
shrink S3: nothing breaks
shrink S4: HF on o1 (1 steps)
shrink S5: HF on o1 (1 steps)
shrink S6: SF on s1f (2 steps)
shrink S7: DX on solo (2 steps)
shrink S8: LW on o1 (8 steps)
shrink H-rem: nothing breaks
shrink S10: nothing breaks
shrink S11: SF on solo (1 steps)
shrink 2.3 rule 1: HF on o1d (4 steps)
shrink 8.9 B1: SF on o1 (1 steps)
shrink 8.9 B4: DX on solo (2 steps)
shrink only voter: HF on o1 (1 steps)
shrink S9: nothing breaks

## Whole sentences dropped

| Sentence | absent | shrink |
|---|---|---|
| G1 | GF on g0 (0 steps) | GF on g0 (0 steps) |
| G2 | HF on o1d (4 steps) | HF on o1d (4 steps) |
| G3 | B2B on o1 (6 steps) | B2B on o1 (6 steps) |
| G4 | HF on o1f (6 steps) | HF on o1f (6 steps) |
| G5 | DL on o1d (1 steps) | DL on o1d (1 steps) |
| H-add | HF on r1s (1 steps) | HF on r1s (1 steps) |
| H-prom | GF on g0 (0 steps) | GF on g0 (0 steps) |
| H-rem | nothing breaks | nothing breaks |
| H-sur | HF on r1s (1 steps) | HF on r1s (1 steps) |
| H-pick | HF on r1s (1 steps) | HF on r1s (1 steps) |
| S1 | SF on o1 (1 steps) | SF on o1 (1 steps) |
| S2 | P7 on o1 (12 steps) | P7 on o1 (12 steps) |
| S3 | nothing breaks | nothing breaks |
| S4 | HF on o1 (1 steps) | HF on o1 (1 steps) |
| S5 | HF on o1 (1 steps) | HF on o1 (1 steps) |
| S6 | SF on s2 (2 steps) | SF on s1f (2 steps) |
| S7 | DX on solo (2 steps) | DX on solo (2 steps) |
| S8 | LW on o1 (8 steps) | LW on o1 (8 steps) |
| S9 | nothing breaks | nothing breaks |
| S10 | nothing breaks | nothing breaks |
| S11 | SF on solo (1 steps) | SF on solo (1 steps) |

## LAYERS rules dropped whole (the sentences that write each)

| LAYERS rule | What | Sentences | absent | shrink |
|---|---|---|---|---|
| 2.3 rule 1 | learners first: a placement of three, the others as learners | G1, G2 | HF on o1d (4 steps) | HF on o1d (4 steps) |
| 2.3 rule 2 | two promotions back to back | G3 | B2B on o1 (6 steps) | B2B on o1 (6 steps) |
| 2.3 rule 3 | two voters step back to one | G4 | HF on o1f (6 steps) | HF on o1f (6 steps) |
| 2.3 rule 4 | a gone learner is dropped | G5 | DL on o1d (1 steps) | DL on o1d (1 steps) |
| 8.9 B1 | say retiring first; no pick, add or promotion of a retiring machine | S1, S2 | SF on o1 (1 steps) | SF on o1 (1 steps) |
| 8.9 B2 | hand over, never to a retiring machine | S3 | nothing breaks | nothing breaks |
| 8.9 B4 | exit once no config names it, or at leave.ms (with the checks and the bound added here) | S7, S11 | DX on solo (2 steps) | DX on solo (2 steps) |
| only voter | the leave of an only voter: promote a learner first (DESIGN-V5), be removed from two | S4, S5 | HF on o1 (1 steps) | HF on o1 (1 steps) |
| V4-60 | dead voters removed first when a leave needs it | S6 | SF on s2 (2 steps) | SF on s1f (2 steps) |
| leaving learner | a leaving learner is dropped | S10 | nothing breaks | nothing breaks |
| meta-members high | a retiring voter is left to its own leave until leave.ms | S9 | nothing breaks | nothing breaks |
| new: write.stay | a leader that appended its own removal takes no new write | S8 | LW on o1 (8 steps) | LW on o1 (8 steps) |

absent: 17 of 21 sentences needed whole; 9 of 12 LAYERS rules needed

shrink: 17 of 21 sentences needed whole; 9 of 12 LAYERS rules needed
